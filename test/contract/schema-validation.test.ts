import assert from "node:assert/strict";
import test from "node:test";

import { validateProtocol } from "../../src/protocol/schemas.js";

const candidateRelease = {
  schemaVersion: "1.0",
  contract: "candidate_release",
  factoryRunId: "fr_fixture_001",
  candidateOrdinal: 1,
  builderStageAttemptId: "fa_builder_001",
  branchRef: "refs/heads/factory/fixture",
  baseSha: "0000000000000000000000000000000000000000",
  headCommitSha: "1111111111111111111111111111111111111111",
  sourceTreeSha: "2222222222222222222222222222222222222222"
};

test("versioned Candidate Release and Authorization examples validate", () => {
  assert.deepEqual(validateProtocol("candidate-release", candidateRelease), {
    ok: true,
    value: candidateRelease
  });

  const authorization = {
    schemaVersion: "1.0",
    contract: "authorization",
    authorizationId: "az_fixture_001",
    kind: "autonomous_low",
    decision: "authorized",
    factoryRunId: "fr_fixture_001",
    candidateHeadSha: candidateRelease.headCommitSha,
    riskClassification: "low",
    recordedAt: "2026-09-28T12:00:00.000Z",
    evidenceDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  };

  assert.deepEqual(validateProtocol("authorization", authorization), {
    ok: true,
    value: authorization
  });
});

test("schemas reject unknown fields rather than granting hidden authority", () => {
  const workerResult = {
    schemaVersion: "1.0",
    contract: "worker_result",
    role: "rollout_babysitter",
    factoryRunId: "fr_fixture_001",
    candidateHeadSha: candidateRelease.headCommitSha,
    inputSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    decision: "enter_observation",
    facts: {
      candidateExposureBasisPoints: 10000,
      stableAvailable: true
    },
    targetState: "succeeded"
  };

  const validation = validateProtocol("worker-result", workerResult);
  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.match(validation.errors.join("\n"), /additional properties|targetState/i);
  }
});

test("terminal cleanup schema rejects contradictory complete outcomes", () => {
  const contradictory = {
    schemaVersion: "1.0",
    contract: "terminal_cleanup_receipt",
    status: "complete",
    terminalOutcome: "failed",
    worktree: { state: "absent" },
    localBranch: { state: "present", sha: candidateRelease.headCommitSha },
    remoteBranch: { state: "present", sha: candidateRelease.headCommitSha },
    pullRequest: {
      state: "merged",
      number: 101,
      headSha: candidateRelease.headCommitSha
    }
  };

  const validation = validateProtocol("terminal-cleanup-receipt", contradictory);

  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.match(validation.errors.join("\n"), /terminalOutcome|pullRequest|must match exactly one schema/i);
  }
});
