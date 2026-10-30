import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRunStore, type RunEvent } from "../../src/journal/file-run-store.js";
import { createFixtureAdapters } from "../../src/orchestrator/fakes.js";
import { runOnceFixture } from "../../src/orchestrator/run-once.js";
import { parseEventId, parseFactoryRunId, parseIssueId } from "../../src/protocol/contracts.js";

test("factory run-once fixture traverses Build through Observe to Succeeded", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-fixture-"));
  try {
    const runDirectory = join(stateRoot, "runs", "fr_fixture_001");
    const store = new FileRunStore(runDirectory);
    const fixture = createFixtureAdapters();

    const snapshot = await runOnceFixture({ store, ...fixture.adapters });

    assert.equal(snapshot.state.lifecycleState, "succeeded");
    assert.equal(snapshot.state.terminalOutcome, "succeeded");
    assert.equal(snapshot.state.candidate?.headCommitSha, "1111111111111111111111111111111111111111");
    assert.ok(snapshot.effects.length > 0);
    assert.ok(snapshot.effects.every((effect) => effect.status === "succeeded"));
    assert.deepEqual(fixture.calls, [
      "GitHubControl.preflight",
      "SourceControl.preflight",
      "GitHubControl.reconcilePendingClaim",
      "GitHubControl.claimOldestReady",
      "GitHubControl.acceptClaim",
      "SourceControl.prepareRun",
      "GitHubControl.publishIssueEvent",
      "RoleRuntime.runBuilder",
      "SourceControl.createCandidate",
      "RoleRuntime.runVerifier",
      "RoleRuntime.runReviewer",
      "SourceControl.readyCandidate",
      "ReleaseTopology.prepareRollout",
      "TelemetryEngine.evaluateRollout",
      "TelemetryEngine.evaluateObservation",
      "SourceControl.integrateCandidate",
      "GitHubControl.projectTerminal",
      "SourceControl.cleanupTerminal"
    ]);

    const lines = (await readFile(join(runDirectory, "run-events.ndjson"), "utf8"))
      .trimEnd()
      .split("\n");
    const events = lines.map((line) => JSON.parse(line) as RunEvent);
    const lifecycleTargets = events.flatMap((event) => {
      if (event.record.kind !== "lifecycle_command") return [];
      return event.record.command.kind === "create_run"
        ? ["building"]
        : [event.record.command.to];
    });
    assert.deepEqual(lifecycleTargets, [
      "building",
      "verifying",
      "reviewing",
      "authorizing",
      "rolling_out",
      "observing",
      "succeeded"
    ]);

    const replayed = await new FileRunStore(runDirectory).rebuildSnapshot();
    assert.deepEqual(replayed, snapshot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("terminal cleanup failure leaves the Terminal Outcome durable and retries the one pending effect", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-fixture-cleanup-retry-"));
  try {
    const runDirectory = join(stateRoot, "runs", "fr_fixture_001");
    const store = new FileRunStore(runDirectory);
    const fixture = createFixtureAdapters();
    const cleanup = fixture.adapters.sourceControl.cleanupTerminal.bind(fixture.adapters.sourceControl);
    let attempts = 0;
    const sourceControl = {
      ...fixture.adapters.sourceControl,
      async cleanupTerminal(input: Parameters<typeof cleanup>[0]) {
        attempts += 1;
        if (attempts === 1) throw new Error("injected terminal cleanup failure");
        return cleanup(input);
      }
    };

    await assert.rejects(
      runOnceFixture({ store, ...fixture.adapters, sourceControl }),
      /injected terminal cleanup failure/
    );
    const afterFailure = await store.load();
    assert.equal(afterFailure?.state.terminalOutcome, "succeeded");
    assert.equal(
      afterFailure?.effects.find((effect) => effect.effect.operation === "projectTerminal")?.status,
      "succeeded"
    );
    assert.equal(
      afterFailure?.effects.find((effect) => effect.effect.operation === "cleanupTerminal")?.status,
      "pending"
    );

    const recovered = await runOnceFixture({ store, ...fixture.adapters, sourceControl });

    assert.equal(recovered.state.terminalOutcome, "succeeded");
    assert.equal(attempts, 2);
    assert.equal(
      recovered.effects.filter((effect) => effect.effect.operation === "cleanupTerminal").length,
      1
    );
    assert.equal(
      recovered.effects.find((effect) => effect.effect.operation === "cleanupTerminal")?.status,
      "succeeded"
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a no-Candidate terminal run omits an unverified synthetic branch from projection", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-fixture-no-candidate-terminal-"));
  try {
    const store = new FileRunStore(join(stateRoot, "runs", "fr_fixture_001"));
    let snapshot = await store.append({
      expectedVersion: 0,
      eventId: parseEventId("evt_no_candidate_create"),
      recordedAt: "2026-09-29T09:00:00.000Z",
      command: {
        kind: "create_run",
        authority: "orchestrator",
        factoryRunId: parseFactoryRunId("fr_fixture_001"),
        issueId: parseIssueId("41")
      }
    });
    snapshot = await store.append({
      expectedVersion: snapshot.version,
      eventId: parseEventId("evt_no_candidate_failed"),
      recordedAt: "2026-09-29T09:00:01.000Z",
      command: {
        kind: "transition",
        authority: "orchestrator",
        to: "failed",
        reason: "Build failed before a Candidate existed",
        evidence: {
          failure: { reason: "builder unavailable", candidateExposureBasisPoints: 0 }
        }
      }
    });
    assert.equal(snapshot.state.candidate, null);
    const fixture = createFixtureAdapters();
    const projectTerminal = fixture.adapters.githubControl.projectTerminal.bind(
      fixture.adapters.githubControl
    );
    let projectedBranchRef: string | null | undefined;
    const githubControl = {
      ...fixture.adapters.githubControl,
      async projectTerminal(input: Parameters<typeof projectTerminal>[0]) {
        projectedBranchRef = input.branchRef;
        return projectTerminal(input);
      }
    };

    const completed = await runOnceFixture({ store, ...fixture.adapters, githubControl });

    assert.equal(completed.state.terminalOutcome, "failed");
    assert.equal(projectedBranchRef, null);
    assert.ok(fixture.calls.includes("SourceControl.observeTerminalBranch"));
    assert.equal(
      completed.effects.filter((effect) => effect.effect.operation === "observeTerminalBranch").length,
      1
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
