import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFactoryRunCommand,
  type FactoryRunCommand,
  type FactoryRunState
} from "../../src/domain/factory-run.js";
import type {
  Authorization,
  CandidateRelease,
  RiskClassification
} from "../../src/protocol/contracts.js";
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

function apply(state: FactoryRunState | null, command: FactoryRunCommand): FactoryRunState {
  const result = applyFactoryRunCommand(state, command);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.state;
}

function stateAtAuthorize(riskClassification: RiskClassification): FactoryRunState {
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
    reason: "Candidate ready",
    evidence: { candidate, builderEvidenceDigest: digest("a") }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "reviewing",
    reason: "verified",
    evidence: {
      candidateHeadSha: candidate.headCommitSha,
      verificationEvidenceDigest: digest("b")
    }
  });
  return apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "authorizing",
    reason: "review complete",
    evidence: {
      review: {
        candidateHeadSha: candidate.headCommitSha,
        disposition: "review_complete",
        riskClassification,
        evidenceDigest: digest("c")
      }
    }
  });
}

function humanAuthorization(decision: "authorized" | "rejected", headSha = candidate.headCommitSha): Authorization {
  return {
    schemaVersion: "1.0",
    contract: "authorization",
    authorizationId: parseAuthorizationId(`az_human_${decision}`),
    kind: "human",
    decision,
    factoryRunId: candidate.factoryRunId,
    candidateHeadSha: headSha,
    riskClassification: "elevated",
    recordedAt: "2026-09-28T12:00:00.000Z",
    evidenceDigest: digest("d")
  };
}

test("Elevated risk waits for exact-Candidate human Authorization", () => {
  let state = stateAtAuthorize("elevated");
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "awaiting_human_authorization",
    reason: "Elevated risk requires a human",
    evidence: {
      authorizationRequest: {
        candidateHeadSha: candidate.headCommitSha,
        evidenceDigest: digest("e")
      }
    }
  });

  const stale = applyFactoryRunCommand(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "stale approval",
    evidence: { authorization: humanAuthorization("authorized", parseGitObjectId("9999999999999999999999999999999999999999")) }
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "STALE_AUTHORIZATION");

  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "human approved exact Candidate",
    evidence: { authorization: humanAuthorization("authorized") }
  });
  assert.equal(state.lifecycleState, "rolling_out");
});

test("Prohibited risk and human rejection terminate as Rejected", () => {
  const prohibited = apply(stateAtAuthorize("prohibited"), {
    kind: "transition",
    authority: "orchestrator",
    to: "rejected",
    reason: "Prohibited is non-waivable",
    evidence: {
      rejection: {
        candidateHeadSha: candidate.headCommitSha,
        source: "policy",
        evidenceDigest: digest("f")
      }
    }
  });
  assert.equal(prohibited.terminalOutcome, "rejected");

  let awaiting = apply(stateAtAuthorize("elevated"), {
    kind: "transition",
    authority: "orchestrator",
    to: "awaiting_human_authorization",
    reason: "human gate",
    evidence: {
      authorizationRequest: {
        candidateHeadSha: candidate.headCommitSha,
        evidenceDigest: digest("e")
      }
    }
  });
  awaiting = apply(awaiting, {
    kind: "transition",
    authority: "orchestrator",
    to: "rejected",
    reason: "human rejected exact Candidate",
    evidence: { authorization: humanAuthorization("rejected") }
  });
  assert.equal(awaiting.terminalOutcome, "rejected");
});

test("Elevated human Authorization cannot skip the waiting Lifecycle State", () => {
  const result = applyFactoryRunCommand(stateAtAuthorize("elevated"), {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "attempt to apply a human decision before waiting",
    evidence: { authorization: humanAuthorization("authorized") }
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "GUARD_REJECTED");
});
