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
  recordedAt: "2026-09-28T12:00:04.000Z",
  evidenceDigest: digest("a")
};

function apply(state: FactoryRunState | null, command: FactoryRunCommand): FactoryRunState {
  const result = applyFactoryRunCommand(state, command);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.state;
}

test("a guarded Low-risk Factory Run traverses Build through Observe to Succeeded", () => {
  let state = apply(null, {
    kind: "create_run",
    authority: "orchestrator",
    factoryRunId: candidate.factoryRunId,
    issueId: parseIssueId("fixture")
  });
  assert.equal(state.lifecycleState, "building");

  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "builder produced Candidate Release",
    evidence: { candidate, builderEvidenceDigest: digest("b") }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "reviewing",
    reason: "Verifier passed exact Candidate Release",
    evidence: {
      candidateHeadSha: candidate.headCommitSha,
      verificationEvidenceDigest: digest("c")
    }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "authorizing",
    reason: "Reviewer completed exact Candidate Release",
    evidence: {
      review: {
        candidateHeadSha: candidate.headCommitSha,
        disposition: "review_complete",
        riskClassification: "low",
        evidenceDigest: digest("d")
      }
    }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "Low risk was autonomously authorized",
    evidence: { authorization }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "observing",
    reason: "Staging and every Progressive Rollout gate passed",
    evidence: {
      rollout: {
        candidateHeadSha: candidate.headCommitSha,
        stagingPassed: true,
        allProgressiveGatesPassed: true,
        candidateExposureBasisPoints: 10000,
        stableAvailable: true,
        evidenceDigest: digest("e")
      }
    }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "succeeded",
    reason: "Observation Window passed",
    evidence: {
      observation: {
        candidateHeadSha: candidate.headCommitSha,
        windowComplete: true,
        telemetryPassed: true,
        unresolvedIncidentCount: 0,
        evidenceDigest: digest("f")
      }
    }
  });

  assert.equal(state.lifecycleState, "succeeded");
  assert.equal(state.terminalOutcome, "succeeded");
  assert.equal(state.version, 7);
  assert.equal(state.candidate?.headCommitSha, candidate.headCommitSha);
});
