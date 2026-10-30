import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRisk,
  type ReviewFinding
} from "../../src/domain/risk-policy.js";
import {
  buildRiskInput,
  lowStructuralRiskFacts,
  phase4OtherCandidateHeadSha
} from "./phase4-fixtures.js";

const repairableFinding = {
  kind: "repairable",
  findingId: "unsafe-rendering",
  category: "security",
  severity: "high",
  disposition: "must_fix",
  scopeRelation: "implementation_defect",
  repairability: "repairable",
  ruleIds: ["E-TRUST-BOUNDARY"],
  rationale: "Untrusted task title bypasses the existing renderer.",
  repairStatement: "Use the existing escaped renderer."
} as const;

const prohibitedFinding = {
  kind: "intrinsic_prohibited",
  findingId: "unsafe-network",
  category: "security",
  severity: "critical",
  disposition: "must_fix",
  scopeRelation: "intrinsic_requirement",
  repairability: "intrinsic_prohibited",
  ruleIds: ["P-EXTERNAL-NETWORK"],
  rationale: "The immutable issue requires public synchronization."
} as const;

test("risk-policy/v1 allowlists Low only when every dimension and structural fact is affirmative", () => {
  assert.deepEqual(evaluateRisk(buildRiskInput()), { disposition: "review_complete", classification: "low", ruleIds: [] });
  assert.deepEqual(evaluateRisk(buildRiskInput({
    evidence: { correctness: true, security: false, operational: true, reversibility: true, scope: true }
  })), {
    disposition: "blocked",
    reasons: ["missing security evidence"]
  });
});

test("structural facts floor risk at Elevated through the typed structural-rule registry", () => {
  const structural = { ...lowStructuralRiskFacts, dependencyOrBuildChange: true };
  assert.equal(evaluateRisk(buildRiskInput({ structural })).disposition, "blocked");
  assert.deepEqual(evaluateRisk(buildRiskInput({ structural, reviewerClassification: "elevated" })), {
    disposition: "review_complete",
    classification: "elevated",
    ruleIds: ["E-DEPENDENCY"]
  });
});

test("missing or invalid evidence blocks before Prohibited or repair classification", () => {
  const result = evaluateRisk(buildRiskInput({
    evidence: { correctness: true, security: false, operational: true, reversibility: true, scope: true },
    reviewerClassification: "prohibited",
    reviewerProhibitedRuleIds: ["P-EXTERNAL-NETWORK"],
    findings: [prohibitedFinding, repairableFinding]
  }));
  assert.deepEqual(result, { disposition: "blocked", reasons: ["missing security evidence"] });
});

test("Reviewer Prohibited rule IDs require matching conclusive intrinsic or unavoidable findings", () => {
  const bare = evaluateRisk(buildRiskInput({
    reviewerClassification: "prohibited",
    reviewerProhibitedRuleIds: ["P-EXTERNAL-NETWORK"]
  }));
  assert.deepEqual(bare, {
    disposition: "blocked",
    reasons: ["Reviewer Prohibited rule P-EXTERNAL-NETWORK lacks a conclusive intrinsic or unavoidable finding"]
  });

  const backed = evaluateRisk(buildRiskInput({
    reviewerClassification: "prohibited",
    reviewerProhibitedRuleIds: ["P-EXTERNAL-NETWORK"],
    findings: [prohibitedFinding]
  }));
  assert.deepEqual(backed, {
    disposition: "review_complete",
    classification: "prohibited",
    ruleIds: ["P-EXTERNAL-NETWORK"]
  });
});

test("repairable must-fix findings return to Build before residual classification", () => {
  const result = evaluateRisk(buildRiskInput({ reviewerClassification: null, findings: [repairableFinding] }));
  assert.deepEqual(result, { disposition: "repair_required", findings: [repairableFinding] });
});

test("stale Candidate evidence and runtime-invalid finding combinations fail closed", () => {
  assert.equal(evaluateRisk(buildRiskInput({ verifierCandidateHeadSha: phase4OtherCandidateHeadSha })).disposition, "blocked");

  const impossibleFinding = {
    kind: "advisory",
    findingId: "critical-advisory",
    category: "correctness",
    severity: "critical",
    disposition: "advisory",
    scopeRelation: "implementation_defect",
    repairability: "not_applicable",
    ruleIds: ["E-CONTRACT"],
    rationale: "contradiction"
  } as unknown as ReviewFinding;
  const contradictory = evaluateRisk(buildRiskInput({ findings: [impossibleFinding] }));
  assert.deepEqual(contradictory, {
    disposition: "blocked",
    reasons: ["critical correctness finding critical-advisory cannot be advisory"]
  });
});

test("Reviewer classification below a structural Prohibited rule or alongside repair evidence is invalid", () => {
  const lowered = evaluateRisk(buildRiskInput({
    structural: { ...lowStructuralRiskFacts, prohibitedRuleIds: ["P-CONTROL-PLANE"] },
    reviewerClassification: "low"
  }));
  assert.equal(lowered.disposition, "blocked");

  const contradictoryRepair = evaluateRisk(buildRiskInput({
    reviewerClassification: "low",
    findings: [repairableFinding]
  }));
  assert.deepEqual(contradictoryRepair, {
    disposition: "blocked",
    reasons: ["review_complete cannot retain a must-fix repairable finding"]
  });
});
