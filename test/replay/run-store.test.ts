import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FactoryRunCommand } from "../../src/domain/factory-run.js";
import { FileRunStore } from "../../src/journal/file-run-store.js";
import type { CandidateRelease } from "../../src/protocol/contracts.js";
import { parseDigest, parseEventId, parseFactoryRunId, parseGitObjectId, parseIssueId, parseStageAttemptId, type Digest } from "../../src/protocol/contracts.js";

const digest = (character: string): Digest => parseDigest(character.repeat(64));
const candidate: CandidateRelease = {
  schemaVersion: "1.0",
  contract: "candidate_release",
  factoryRunId: parseFactoryRunId("fr_fixture_001"),
  candidateOrdinal: 1,
  builderStageAttemptId: parseStageAttemptId("fa_builder_001"),
  branchRef: "refs/heads/factory/fixture",
  baseSha: parseGitObjectId("0000000000000000000000000000000000000000"),
  headCommitSha: parseGitObjectId("1111111111111111111111111111111111111111"),
  sourceTreeSha: parseGitObjectId("2222222222222222222222222222222222222222")
};
const commands: readonly FactoryRunCommand[] = [
  {
    kind: "create_run",
    authority: "orchestrator",
    factoryRunId: candidate.factoryRunId,
    issueId: parseIssueId("fixture")
  },
  {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "Candidate ready",
    evidence: { candidate, builderEvidenceDigest: digest("a") }
  }
];

test("append-only replay rebuilds an identical snapshot", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "factory-run-store-"));
  try {
    const store = new FileRunStore(runDirectory);
    let snapshot = await store.append({
      expectedVersion: 0,
      eventId: parseEventId("evt_fixture_001"),
      recordedAt: "2026-09-28T12:00:00.000Z",
      command: commands[0] as FactoryRunCommand
    });
    snapshot = await store.append({
      expectedVersion: snapshot.state.version,
      eventId: parseEventId("evt_fixture_002"),
      recordedAt: "2026-09-28T12:00:01.000Z",
      command: commands[1] as FactoryRunCommand
    });

    const originalSnapshot = snapshot;
    const persisted = JSON.parse(await readFile(join(runDirectory, "run-snapshot.json"), "utf8"));
    assert.deepEqual(persisted, originalSnapshot);

    await unlink(join(runDirectory, "run-snapshot.json"));
    const restarted = new FileRunStore(runDirectory);
    const replayed = await restarted.rebuildSnapshot();

    assert.deepEqual(replayed, originalSnapshot);
    assert.equal(replayed.stateDigest, originalSnapshot.stateDigest);
    assert.equal(replayed.lastEventDigest, originalSnapshot.lastEventDigest);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
