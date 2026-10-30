import type { FactoryRunState } from "../../src/domain/factory-run.js";
import type {
  RiskEvaluationInput,
  StructuralRiskFacts
} from "../../src/domain/risk-policy.js";
import type { LowAuthorizationGuards } from "../../src/orchestrator/review-authorization.js";
import {
  parseDigest,
  parseFactoryRunId,
  parseGitObjectId,
  parseIssueId,
  parseStageAttemptId,
  type CandidateRelease
} from "../../src/protocol/contracts.js";

export const phase4RunId = parseFactoryRunId("fr_review_branches");
export const phase4OtherCandidateHeadSha = parseGitObjectId("9".repeat(40));

export const phase4Candidate: CandidateRelease = {
  schemaVersion: "1.0",
  contract: "candidate_release",
  factoryRunId: phase4RunId,
  candidateOrdinal: 1,
  builderStageAttemptId: parseStageAttemptId("fa_review_builder"),
  branchRef: "refs/heads/factory/review-branches",
  baseSha: parseGitObjectId("0".repeat(40)),
  headCommitSha: parseGitObjectId("1".repeat(40)),
  sourceTreeSha: parseGitObjectId("2".repeat(40))
};

export const lowStructuralRiskFacts: StructuralRiskFacts = {
  complete: true,
  changedOnlyAllowedProductPaths: true,
  acceptanceCriteriaCovered: true,
  dependencyOrBuildChange: false,
  operationsChange: false,
  persistentDataShapeChange: false,
  dataMutationChange: false,
  trustBoundaryChange: false,
  publicContractChange: false,
  concurrencyChange: false,
  broadCrossLayerChange: false,
  rollbackCompatibilityRequired: false,
  materialResourceChange: false,
  prohibitedRuleIds: []
};

export const phase4ReviewingState: FactoryRunState = {
  schemaVersion: "1.0",
  factoryRunId: phase4RunId,
  issueId: parseIssueId("91"),
  version: 4,
  lifecycleState: "reviewing",
  candidate: phase4Candidate,
  candidateHistory: [phase4Candidate],
  builderEvidenceDigest: parseDigest("a".repeat(64)),
  verification: { candidateHeadSha: phase4Candidate.headCommitSha, evidenceDigest: parseDigest("b".repeat(64)) },
  review: null,
  authorization: null,
  rollout: null,
  observation: null,
  candidateExposureBasisPoints: 0,
  paused: null,
  rollback: null,
  terminalOutcome: null
};

export function buildLowAuthorizationGuards(overrides: Partial<LowAuthorizationGuards> = {}): LowAuthorizationGuards {
  return {
    verification: { candidateHeadSha: phase4Candidate.headCommitSha, passed: true, fresh: true },
    review: { candidateHeadSha: phase4Candidate.headCommitSha, complete: true, fresh: true },
    policy: {
      policyId: "risk-policy/v1",
      observedHash: parseDigest("c".repeat(64)),
      expectedHash: parseDigest("c".repeat(64)),
      fresh: true
    },
    requiredChecks: { candidateHeadSha: phase4Candidate.headCommitSha, passed: true, fresh: true },
    source: {
      candidateHeadSha: phase4Candidate.headCommitSha,
      baseSha: phase4Candidate.baseSha,
      sourceTreeSha: phase4Candidate.sourceTreeSha,
      passed: true,
      fresh: true
    },
    lifecycle: { state: "reviewing", fresh: true },
    unresolvedIncidentCount: 0,
    ...overrides
  };
}

export function buildRiskInput(overrides: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    policyId: "risk-policy/v1",
    factoryRunId: phase4RunId,
    candidateHeadSha: phase4Candidate.headCommitSha,
    verifierCandidateHeadSha: phase4Candidate.headCommitSha,
    reviewerCandidateHeadSha: phase4Candidate.headCommitSha,
    sourceIdentityUnchanged: true,
    structural: lowStructuralRiskFacts,
    evidence: { correctness: true, security: true, operational: true, reversibility: true, scope: true },
    findings: [],
    reviewerClassification: "low",
    reviewerElevatedRuleIds: [],
    reviewerProhibitedRuleIds: [],
    ...overrides
  };
}
