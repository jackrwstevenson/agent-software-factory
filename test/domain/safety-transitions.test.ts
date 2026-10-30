import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFactoryRunCommand,
  type FactoryRunCommand,
  type FactoryRunState
} from "../../src/domain/factory-run.js";
import type { Authorization, CandidateRelease } from "../../src/protocol/contracts.js";
import { parseDigest, parseFactoryRunId, parseGitObjectId, type Digest, parseAuthorizationId, parseIssueId, parseStageAttemptId } from "../../src/protocol/contracts.js";

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
const authorization: Authorization = {
  schemaVersion: "1.0",
  contract: "authorization",
  authorizationId: parseAuthorizationId("az_fixture_001"),
  kind: "autonomous_low",
  decision: "authorized",
  factoryRunId: candidate.factoryRunId,
  candidateHeadSha: candidate.headCommitSha,
  riskClassification: "low",
  recordedAt: "2026-09-28T12:00:00.000Z",
  evidenceDigest: digest("a")
};

function apply(state: FactoryRunState | null, command: FactoryRunCommand): FactoryRunState {
  const result = applyFactoryRunCommand(state, command);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.state;
}

function stateAtRollingOut(): FactoryRunState {
  let state = apply(null, {
    kind: "create_run",
    authority: "orchestrator",
    factoryRunId: candidate.factoryRunId,
    issueId: parseIssueId("fixture")
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "built",
    evidence: { candidate, builderEvidenceDigest: digest("b") }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "reviewing",
    reason: "verified",
    evidence: {
      candidateHeadSha: candidate.headCommitSha,
      verificationEvidenceDigest: digest("c")
    }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "authorizing",
    reason: "reviewed",
    evidence: {
      review: {
        candidateHeadSha: candidate.headCommitSha,
        disposition: "review_complete",
        riskClassification: "low",
        evidenceDigest: digest("d")
      }
    }
  });
  return apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "authorized",
    evidence: { authorization }
  });
}

test("pause retains the blocked Stage and only resumes after reconciliation", () => {
  let state = stateAtRollingOut();
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "paused_for_operator",
    reason: "routing identity is ambiguous",
    evidence: {
      pause: {
        blockedStage: "rollout",
        reason: "routing identity is ambiguous",
        candidateExposureBasisPoints: 0
      }
    }
  });
  assert.equal(state.paused?.priorState, "rolling_out");

  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "identity reconciled",
    evidence: { resumption: { reconciled: true, evidenceDigest: digest("e") } }
  });
  assert.equal(state.lifecycleState, "rolling_out");
});

test("nonzero Candidate exposure requires rollback before human abort", () => {
  const rollingOut = stateAtRollingOut();
  const unsafeAbort = applyFactoryRunCommand(rollingOut, {
    kind: "transition",
    authority: "orchestrator",
    to: "aborted",
    reason: "human abort",
    evidence: { abort: { reason: "operator stopped run", candidateExposureBasisPoints: 3000 } }
  });
  assert.equal(unsafeAbort.ok, false);
  if (!unsafeAbort.ok) assert.equal(unsafeAbort.error.code, "GUARD_REJECTED");

  let state = apply(rollingOut, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_back",
    reason: "abort requires Stable restoration",
    evidence: {
      rollback: {
        trigger: "human_abort",
        candidateHeadSha: candidate.headCommitSha,
        candidateExposureBasisPoints: 3000,
        evidenceDigest: digest("f")
      }
    }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "aborted",
    reason: "Stable restoration confirmed",
    evidence: {
      rollbackConfirmation: {
        stableRestoration: "confirmed",
        evidenceDigest: digest("1")
      }
    }
  });
  assert.equal(state.terminalOutcome, "aborted");
});

test("safety rollback and failed Stable restoration have distinct Terminal Outcomes", () => {
  let rolledBack = apply(stateAtRollingOut(), {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_back",
    reason: "Candidate failed after exposure",
    evidence: {
      rollback: {
        trigger: "safety",
        candidateHeadSha: candidate.headCommitSha,
        candidateExposureBasisPoints: 500,
        evidenceDigest: digest("2")
      }
    }
  });
  rolledBack = apply(rolledBack, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolled_back",
    reason: "Stable restored",
    evidence: {
      rollbackConfirmation: {
        stableRestoration: "confirmed",
        evidenceDigest: digest("3")
      }
    }
  });
  assert.equal(rolledBack.terminalOutcome, "rolled_back");

  let failed = apply(stateAtRollingOut(), {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_back",
    reason: "Candidate failed after exposure",
    evidence: {
      rollback: {
        trigger: "safety",
        candidateHeadSha: candidate.headCommitSha,
        candidateExposureBasisPoints: 500,
        evidenceDigest: digest("4")
      }
    }
  });
  failed = apply(failed, {
    kind: "transition",
    authority: "orchestrator",
    to: "failed",
    reason: "Stable could not be confirmed",
    evidence: {
      rollbackConfirmation: {
        stableRestoration: "failed",
        evidenceDigest: digest("5")
      }
    }
  });
  assert.equal(failed.terminalOutcome, "failed");
});

test("recorded exposure cannot be downgraded to bypass rollback", () => {
  let paused = apply(stateAtRollingOut(), {
    kind: "transition",
    authority: "orchestrator",
    to: "paused_for_operator",
    reason: "pause after exposure",
    evidence: {
      pause: {
        blockedStage: "rollout",
        reason: "pause after exposure",
        candidateExposureBasisPoints: 500
      }
    }
  });

  const directAbort = applyFactoryRunCommand(paused, {
    kind: "transition",
    authority: "orchestrator",
    to: "aborted",
    reason: "claim exposure disappeared",
    evidence: { abort: { reason: "operator stopped run", candidateExposureBasisPoints: 0 } }
  });
  assert.equal(directAbort.ok, false);
  if (!directAbort.ok) assert.equal(directAbort.error.code, "GUARD_REJECTED");

  paused = apply(paused, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "reconciled",
    evidence: { resumption: { reconciled: true, evidenceDigest: digest("6") } }
  });
  const directFailure = applyFactoryRunCommand(paused, {
    kind: "transition",
    authority: "orchestrator",
    to: "failed",
    reason: "claim exposure disappeared",
    evidence: { failure: { reason: "technical failure", candidateExposureBasisPoints: 0 } }
  });
  assert.equal(directFailure.ok, false);
  if (!directFailure.ok) assert.equal(directFailure.error.code, "GUARD_REJECTED");
});
