import type { FactoryRunCommand, FactoryRunState } from "../domain/factory-run.js";
import { evaluateRisk, RISK_POLICY_ID, type RiskEvaluationInput } from "../domain/risk-policy.js";
import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { AuthorizationId, Digest, GitObjectId, LifecycleState } from "../protocol/contracts.js";

interface FreshCandidateGuard {
  readonly candidateHeadSha: GitObjectId;
  readonly fresh: boolean;
}

export interface LowAuthorizationGuards {
  readonly verification: FreshCandidateGuard & { readonly passed: boolean };
  readonly review: FreshCandidateGuard & { readonly complete: boolean };
  readonly policy: {
    readonly policyId: string;
    readonly observedHash: Digest;
    readonly expectedHash: Digest;
    readonly fresh: boolean;
  };
  readonly requiredChecks: FreshCandidateGuard & { readonly passed: boolean };
  readonly source: FreshCandidateGuard & {
    readonly baseSha: GitObjectId;
    readonly sourceTreeSha: GitObjectId;
    readonly passed: boolean;
  };
  readonly lifecycle: { readonly state: LifecycleState; readonly fresh: boolean };
  readonly unresolvedIncidentCount: number;
}

export interface ReviewAuthorizationPlanningInput {
  readonly state: FactoryRunState;
  readonly risk: RiskEvaluationInput;
  readonly lowAuthorizationGuards: LowAuthorizationGuards | null;
  readonly authorizationId: AuthorizationId;
  readonly recordedAt: string;
}

function lowGuardFailures(state: FactoryRunState, guards: LowAuthorizationGuards | null): string[] {
  if (state.candidate === null) return ["Low Authorization requires an exact Candidate"];
  if (guards === null) return ["fresh Low Authorization guards are absent"];
  const candidate = state.candidate;
  const failures: string[] = [];
  if (!guards.verification.fresh || !guards.verification.passed || guards.verification.candidateHeadSha !== candidate.headCommitSha) failures.push("verification guard is stale, failed, or Candidate-mismatched");
  if (!guards.review.fresh || !guards.review.complete || guards.review.candidateHeadSha !== candidate.headCommitSha) failures.push("review guard is stale, incomplete, or Candidate-mismatched");
  if (!guards.policy.fresh || guards.policy.policyId !== RISK_POLICY_ID || guards.policy.observedHash !== guards.policy.expectedHash) failures.push("risk-policy hash guard is stale or mismatched");
  if (!guards.requiredChecks.fresh || !guards.requiredChecks.passed || guards.requiredChecks.candidateHeadSha !== candidate.headCommitSha) failures.push("required-check guard is stale, failed, or Candidate-mismatched");
  if (
    !guards.source.fresh || !guards.source.passed ||
    guards.source.candidateHeadSha !== candidate.headCommitSha ||
    guards.source.baseSha !== candidate.baseSha ||
    guards.source.sourceTreeSha !== candidate.sourceTreeSha
  ) failures.push("base/source guard is stale, failed, or identity-mismatched");
  if (!guards.lifecycle.fresh || guards.lifecycle.state !== state.lifecycleState || state.lifecycleState !== "reviewing") failures.push("Lifecycle State guard is stale or mismatched");
  if (guards.unresolvedIncidentCount !== 0) failures.push("Low Authorization requires zero unresolved Incidents");
  return failures;
}

export function planReviewAuthorization(input: ReviewAuthorizationPlanningInput): readonly FactoryRunCommand[] {
  if (input.state.lifecycleState !== "reviewing" || input.state.candidate === null) {
    throw new Error("review/Authorization planning requires Reviewing with an exact Candidate");
  }
  if (input.risk.factoryRunId !== input.state.factoryRunId || input.risk.candidateHeadSha !== input.state.candidate.headCommitSha) {
    throw new Error("risk evidence is stale for the active Factory Run or Candidate");
  }
  const evaluation = evaluateRisk(input.risk);
  const evaluationDigest = canonicalSha256(evaluation);
  if (evaluation.disposition === "blocked") {
    return [{ kind: "transition", authority: "orchestrator", to: "paused_for_operator", reason: evaluation.reasons.join("; "), evidence: { pause: { blockedStage: "review", reason: evaluation.reasons.join("; ") } } }];
  }
  if (evaluation.disposition === "repair_required") {
    return [{ kind: "transition", authority: "orchestrator", to: "building", reason: "Reviewer requested a bounded product repair", evidence: { repair: { candidateHeadSha: input.state.candidate.headCommitSha, requestedBy: "reviewer", evidenceDigest: evaluationDigest } } }];
  }

  const reviewCommand: FactoryRunCommand = {
    kind: "transition", authority: "orchestrator", to: "authorizing",
    reason: "Reviewer completed the exact Candidate under risk-policy/v1",
    evidence: { review: { candidateHeadSha: input.state.candidate.headCommitSha, disposition: "review_complete", riskClassification: evaluation.classification, evidenceDigest: evaluationDigest } }
  };
  if (evaluation.classification === "prohibited") {
    return [reviewCommand, { kind: "transition", authority: "orchestrator", to: "rejected", reason: `non-waivable Prohibited rule: ${evaluation.ruleIds.join(", ")}`, evidence: { rejection: { candidateHeadSha: input.state.candidate.headCommitSha, source: "policy", evidenceDigest: evaluationDigest } } }];
  }
  if (evaluation.classification === "elevated") {
    return [reviewCommand, { kind: "transition", authority: "orchestrator", to: "awaiting_human_authorization", reason: `Elevated residual risk requires exact run-and-SHA human Authorization: ${evaluation.ruleIds.join(", ")}`, evidence: { authorizationRequest: { candidateHeadSha: input.state.candidate.headCommitSha, evidenceDigest: evaluationDigest } } }];
  }
  const guardFailures = lowGuardFailures(input.state, input.lowAuthorizationGuards);
  if (guardFailures.length > 0) {
    const reason = guardFailures.join("; ");
    return [reviewCommand, { kind: "transition", authority: "orchestrator", to: "paused_for_operator", reason, evidence: { pause: { blockedStage: "authorize", reason } } }];
  }
  return [reviewCommand, {
    kind: "transition", authority: "orchestrator", to: "rolling_out", reason: "Low risk was autonomously authorized after all guards passed",
    evidence: { authorization: { schemaVersion: "1.0", contract: "authorization", authorizationId: input.authorizationId, kind: "autonomous_low", decision: "authorized", factoryRunId: input.state.factoryRunId, candidateHeadSha: input.state.candidate.headCommitSha, riskClassification: "low", recordedAt: input.recordedAt, evidenceDigest: evaluationDigest } }
  }];
}
