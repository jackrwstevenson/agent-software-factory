import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GitHubPreflightEvidence } from "../../src/control/contracts.js";
import { REQUIRED_FACTORY_LABELS } from "../../src/control/config.js";
import { FileSourceCapabilityStore } from "../../src/control/source-capability-store.js";
import { isConclusiveLinkedBranchUnsupported } from "../../src/control/phase2-adapters.js";

function evidence(linkedBranchCapability: "supported" | "unsupported"): GitHubPreflightEvidence {
  return {
    host: "github.org.com",
    restApiVersion: "2022-11-28",
    cliVersion: "2.96.0",
    authenticated: true,
    login: "GH_ENTERPRISE_USERNAME",
    enterpriseVersion: "3.19.10",
    repository: "engineering/agentic-software-factory",
    defaultBranch: "main",
    issuesEnabled: true,
    permission: "admin",
    labels: REQUIRED_FACTORY_LABELS,
    linkedBranchCapability,
    linkedBranchCapabilityEvidence: `probe classified linked branches ${linkedBranchCapability}`,
    readable: {
      issues: true,
      comments: true,
      pullRequests: true,
      defaultBranchCommit: true,
      commitStatuses: true
    }
  };
}

test("linked-branch capability durably selects linked mode or the pure-Git fallback", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-source-capability-"));
  try {
    const store = new FileSourceCapabilityStore(join(stateRoot, "source-capability.json"));
    const fallback = await store.record(evidence("unsupported"), "2026-09-28T12:00:00.000Z");
    assert.equal(fallback.selectedBranchMode, "pure_git");
    assert.deepEqual(await store.load(), fallback);

    const linked = await store.record(evidence("supported"), "2026-09-28T12:01:00.000Z");
    assert.equal(linked.selectedBranchMode, "linked");
    assert.deepEqual(await store.load(), linked);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a run-bound branch mode is reused even when a later capability probe changes", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-run-capability-"));
  try {
    const { createPhase2ControlEnvironment } = await import("../../src/control/phase2-adapters.js");
    const environment = createPhase2ControlEnvironment({
      repositoryRoot: stateRoot,
      stateRoot
    });
    const runId = "fr_capability_001";
    await environment.sourceControlFor(evidence("unsupported"), "2026-09-28T12:00:00.000Z");
    await environment.bindSourceCapability(runId);

    await environment.sourceControlFor(evidence("supported"), "2026-09-28T12:05:00.000Z", runId);
    const persisted = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(stateRoot, "runs", runId, "source-capability.json"),
        "utf8"
      )
    ) as { selectedBranchMode: string };
    assert.equal(persisted.selectedBranchMode, "pure_git");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("only conclusive linked-branch incompatibility permits the pure-Git fallback", () => {
  assert.equal(isConclusiveLinkedBranchUnsupported("GraphQL field createLinkedBranch does not exist"), true);
  assert.equal(isConclusiveLinkedBranchUnsupported("linked branches are not supported on this server"), true);
  assert.equal(isConclusiveLinkedBranchUnsupported("HTTP 403 Resource not accessible by integration"), false);
  assert.equal(isConclusiveLinkedBranchUnsupported("HTTP 503 service unavailable"), false);
  assert.equal(isConclusiveLinkedBranchUnsupported("ambiguous gh issue develop failure"), false);
});
