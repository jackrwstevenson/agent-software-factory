import assert from "node:assert/strict";
import test from "node:test";

import type { RiskEvaluationInput } from "../../src/domain/risk-policy.js";
import { planReviewAuthorization } from "../../src/orchestrator/review-authorization.js";
import { parseAuthorizationId, parseDigest } from "../../src/protocol/contracts.js";
import {
  buildLowAuthorizationGuards,
  buildRiskInput,
  lowStructuralRiskFacts,
  phase4Candidate,
  phase4ReviewingState
} from "../domain/phase4-fixtures.js";

function plan(risk: RiskEvaluationInput, lowAuthorizationGuards = buildLowAuthorizationGuards()) {
  return planReviewAuthorization({
    state: phase4ReviewingState,
    risk,
    lowAuthorizationGuards,
    authorizationId: parseAuthorizationId("az_review_branches"),
    recordedAt: "2026-09-29T08:00:00.000Z"
  });
}

test("Low review produces autonomous exact-Candidate Authorization only after every fresh exact guard", () => {
  const commands = plan(buildRiskInput());
  assert.deepEqual(commands.map((command) => command.kind === "transition" ? command.to : command.kind), ["authorizing", "rolling_out"]);
  const authorization = commands[1]?.kind === "transition" ? commands[1].evidence.authorization : undefined;
  assert.equal(authorization?.kind, "autonomous_low");
  assert.equal(authorization?.candidateHeadSha, phase4Candidate.headCommitSha);
});

test("Low autonomous Authorization fails closed on every stale, mismatched, or failed guard", () => {
  const stale = parseDigest("d".repeat(64));
  const cases = [
    buildLowAuthorizationGuards({ verification: { candidateHeadSha: phase4Candidate.headCommitSha, passed: true, fresh: false } }),
    buildLowAuthorizationGuards({ review: { candidateHeadSha: phase4Candidate.headCommitSha, complete: false, fresh: true } }),
    buildLowAuthorizationGuards({ policy: { policyId: "risk-policy/v1", observedHash: stale, expectedHash: parseDigest("c".repeat(64)), fresh: true } }),
    buildLowAuthorizationGuards({ requiredChecks: { candidateHeadSha: phase4Candidate.headCommitSha, passed: false, fresh: true } }),
    buildLowAuthorizationGuards({ source: { candidateHeadSha: phase4Candidate.headCommitSha, baseSha: phase4Candidate.baseSha, sourceTreeSha: phase4Candidate.sourceTreeSha, passed: false, fresh: true } }),
    buildLowAuthorizationGuards({ lifecycle: { state: "authorizing", fresh: true } }),
    buildLowAuthorizationGuards({ unresolvedIncidentCount: 1 })
  ];
  for (const guards of cases) {
    const commands = plan(buildRiskInput(), guards);
    assert.deepEqual(commands.map((command) => command.kind === "transition" ? command.to : command.kind), ["authorizing", "paused_for_operator"]);
    assert.equal(commands.some((command) => command.kind === "transition" && command.evidence.authorization !== undefined), false);
  }
});

test("Elevated review waits for exact run-and-SHA human Authorization", () => {
  const commands = plan(buildRiskInput({
    structural: { ...lowStructuralRiskFacts, dependencyOrBuildChange: true },
    reviewerClassification: "elevated"
  }));
  assert.deepEqual(commands.map((command) => command.kind === "transition" ? command.to : command.kind), ["authorizing", "awaiting_human_authorization"]);
});

test("intrinsic Prohibited review rejects without an approval request", () => {
  const commands = plan(buildRiskInput({
    reviewerClassification: "prohibited",
    reviewerProhibitedRuleIds: ["P-EXTERNAL-NETWORK"],
    findings: [{
      kind: "intrinsic_prohibited",
      findingId: "external-network",
      category: "security",
      severity: "critical",
      disposition: "must_fix",
      scopeRelation: "intrinsic_requirement",
      repairability: "intrinsic_prohibited",
      ruleIds: ["P-EXTERNAL-NETWORK"],
      rationale: "The immutable request requires an external service."
    }]
  }));
  assert.deepEqual(commands.map((command) => command.kind === "transition" ? command.to : command.kind), ["authorizing", "rejected"]);
});

test("repairable findings return to Build and invalid evidence pauses", () => {
  const repair = plan(buildRiskInput({
    reviewerClassification: null,
    findings: [{
      kind: "repairable",
      findingId: "repair-scope",
      category: "scope",
      severity: "medium",
      disposition: "must_fix",
      scopeRelation: "implementation_defect",
      repairability: "repairable",
      ruleIds: ["E-BLAST-RADIUS"],
      rationale: "Unrelated refactor",
      repairStatement: "Remove unrelated changes"
    }]
  }));
  assert.deepEqual(repair.map((command) => command.kind === "transition" ? command.to : command.kind), ["building"]);
  const blocked = plan(buildRiskInput({ sourceIdentityUnchanged: false }));
  assert.deepEqual(blocked.map((command) => command.kind === "transition" ? command.to : command.kind), ["paused_for_operator"]);
});
