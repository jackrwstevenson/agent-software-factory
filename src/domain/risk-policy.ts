import type { FactoryRunId, GitObjectId, RiskClassification } from "../protocol/contracts.js";

export const RISK_POLICY_ID = "risk-policy/v1" as const;

export type RiskDimension = "correctness" | "security" | "operational" | "reversibility" | "scope";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingDisposition = "must_fix" | "advisory";
export type ScopeRelation = "implementation_defect" | "intrinsic_requirement" | "unavoidable_residual";
export type Repairability = "repairable" | "intrinsic_prohibited" | "not_applicable";

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type ElevatedRuleId =
  | "E-DATA-SCHEMA"
  | "E-DATA-MUTATION"
  | "E-TRUST-BOUNDARY"
  | "E-DEPENDENCY"
  | "E-OPERATIONS"
  | "E-CONTRACT"
  | "E-CONCURRENCY"
  | "E-BLAST-RADIUS"
  | "E-ROLLBACK"
  | "E-RESOURCE";

export type ProhibitedRuleId =
  | "P-CONTROL-PLANE"
  | "P-ARBITRARY-EXECUTION"
  | "P-EXTERNAL-NETWORK"
  | "P-SAFETY-BYPASS"
  | "P-IRREVERSIBLE-DATA-LOSS"
  | "P-UNPINNED-DYNAMIC-CODE"
  | "P-UNREVIEWABLE-ARTIFACT"
  | "P-OUT-OF-SCOPE-PLATFORM";

interface ReviewFindingBase {
  readonly findingId: string;
  readonly rationale: string;
}

export interface RepairableReviewFinding extends ReviewFindingBase {
  readonly kind: "repairable";
  readonly category: RiskDimension;
  readonly severity: FindingSeverity;
  readonly disposition: "must_fix";
  readonly scopeRelation: "implementation_defect";
  readonly repairability: "repairable";
  readonly ruleIds: readonly ElevatedRuleId[];
  readonly repairStatement: string;
}

export interface IntrinsicProhibitedReviewFinding extends ReviewFindingBase {
  readonly kind: "intrinsic_prohibited";
  readonly category: RiskDimension;
  readonly severity: FindingSeverity;
  readonly disposition: "must_fix";
  readonly scopeRelation: "intrinsic_requirement" | "unavoidable_residual";
  readonly repairability: "intrinsic_prohibited";
  readonly ruleIds: NonEmptyReadonlyArray<ProhibitedRuleId>;
}

type CorrectnessOrSecurityAdvisory = {
  readonly category: "correctness" | "security";
  readonly severity: "medium" | "low";
};

type OtherAdvisory = {
  readonly category: "operational" | "reversibility" | "scope";
  readonly severity: FindingSeverity;
};

export type AdvisoryReviewFinding = ReviewFindingBase & {
  readonly kind: "advisory";
  readonly disposition: "advisory";
  readonly scopeRelation: "implementation_defect" | "intrinsic_requirement";
  readonly repairability: "not_applicable";
  readonly ruleIds: NonEmptyReadonlyArray<ElevatedRuleId>;
} & (CorrectnessOrSecurityAdvisory | OtherAdvisory);

export type ReviewFinding = RepairableReviewFinding | IntrinsicProhibitedReviewFinding | AdvisoryReviewFinding;

export interface StructuralRiskFacts {
  readonly complete: boolean;
  readonly changedOnlyAllowedProductPaths: boolean;
  readonly acceptanceCriteriaCovered: boolean;
  readonly dependencyOrBuildChange: boolean;
  readonly operationsChange: boolean;
  readonly persistentDataShapeChange: boolean;
  readonly dataMutationChange: boolean;
  readonly trustBoundaryChange: boolean;
  readonly publicContractChange: boolean;
  readonly concurrencyChange: boolean;
  readonly broadCrossLayerChange: boolean;
  readonly rollbackCompatibilityRequired: boolean;
  readonly materialResourceChange: boolean;
  readonly prohibitedRuleIds: readonly ProhibitedRuleId[];
}

type StructuralElevatedFact =
  | "dependencyOrBuildChange"
  | "operationsChange"
  | "persistentDataShapeChange"
  | "dataMutationChange"
  | "trustBoundaryChange"
  | "publicContractChange"
  | "concurrencyChange"
  | "broadCrossLayerChange"
  | "rollbackCompatibilityRequired"
  | "materialResourceChange";

export const STRUCTURAL_ELEVATED_RULES = {
  persistentDataShapeChange: "E-DATA-SCHEMA",
  dataMutationChange: "E-DATA-MUTATION",
  trustBoundaryChange: "E-TRUST-BOUNDARY",
  dependencyOrBuildChange: "E-DEPENDENCY",
  operationsChange: "E-OPERATIONS",
  publicContractChange: "E-CONTRACT",
  concurrencyChange: "E-CONCURRENCY",
  broadCrossLayerChange: "E-BLAST-RADIUS",
  rollbackCompatibilityRequired: "E-ROLLBACK",
  materialResourceChange: "E-RESOURCE"
} as const satisfies Readonly<Record<StructuralElevatedFact, ElevatedRuleId>>;

export interface RiskEvidenceCompleteness {
  readonly correctness: boolean;
  readonly security: boolean;
  readonly operational: boolean;
  readonly reversibility: boolean;
  readonly scope: boolean;
}

export interface RiskEvaluationInput {
  readonly policyId: string;
  readonly factoryRunId: FactoryRunId;
  readonly candidateHeadSha: GitObjectId;
  readonly verifierCandidateHeadSha: GitObjectId;
  readonly reviewerCandidateHeadSha: GitObjectId;
  readonly sourceIdentityUnchanged: boolean;
  readonly structural: StructuralRiskFacts;
  readonly evidence: RiskEvidenceCompleteness;
  readonly findings: readonly ReviewFinding[];
  readonly reviewerClassification: RiskClassification | null;
  readonly reviewerElevatedRuleIds: readonly ElevatedRuleId[];
  readonly reviewerProhibitedRuleIds: readonly ProhibitedRuleId[];
}

export type RiskEvaluation =
  | { readonly disposition: "blocked"; readonly reasons: readonly string[] }
  | { readonly disposition: "repair_required"; readonly findings: readonly RepairableReviewFinding[] }
  | { readonly disposition: "review_complete"; readonly classification: "low"; readonly ruleIds: readonly [] }
  | { readonly disposition: "review_complete"; readonly classification: "elevated"; readonly ruleIds: readonly ElevatedRuleId[] }
  | { readonly disposition: "review_complete"; readonly classification: "prohibited"; readonly ruleIds: readonly ProhibitedRuleId[] };

const dimensionNames: readonly RiskDimension[] = ["correctness", "security", "operational", "reversibility", "scope"];

function allRulesHavePrefix(rules: readonly string[], prefix: "E-" | "P-"): boolean {
  return rules.every((rule) => rule.startsWith(prefix));
}

function validateFinding(finding: ReviewFinding): string | null {
  const raw = finding as unknown as {
    readonly kind?: string;
    readonly findingId?: string;
    readonly category?: string;
    readonly severity?: string;
    readonly disposition?: string;
    readonly scopeRelation?: string;
    readonly repairability?: string;
    readonly ruleIds?: readonly string[];
    readonly rationale?: string;
    readonly repairStatement?: string;
  };
  const findingId = raw.findingId ?? "unknown";
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(findingId)) return `invalid finding ID ${findingId}`;
  if ((raw.rationale?.trim().length ?? 0) === 0) return `finding ${findingId} lacks a rationale`;

  if (raw.kind === "repairable") {
    if (
      raw.disposition !== "must_fix" ||
      raw.scopeRelation !== "implementation_defect" ||
      raw.repairability !== "repairable"
    ) return `repairable finding ${findingId} has contradictory fields`;
    if ((raw.repairStatement?.trim().length ?? 0) === 0) {
      return `repairable finding ${findingId} lacks an actionable repair statement`;
    }
    if (!Array.isArray(raw.ruleIds) || !allRulesHavePrefix(raw.ruleIds, "E-")) {
      return `repairable finding ${findingId} contains a non-Elevated rule`;
    }
    return null;
  }

  if (raw.kind === "intrinsic_prohibited") {
    if (
      raw.disposition !== "must_fix" ||
      (raw.scopeRelation !== "intrinsic_requirement" && raw.scopeRelation !== "unavoidable_residual") ||
      raw.repairability !== "intrinsic_prohibited"
    ) return `Prohibited finding ${findingId} is not intrinsic or unavoidable`;
    if (!Array.isArray(raw.ruleIds) || raw.ruleIds.length === 0 || !allRulesHavePrefix(raw.ruleIds, "P-")) {
      return `Prohibited finding ${findingId} lacks a Prohibited rule`;
    }
    return null;
  }

  if (raw.kind === "advisory") {
    if (
      raw.disposition !== "advisory" ||
      raw.repairability !== "not_applicable" ||
      (raw.scopeRelation !== "implementation_defect" && raw.scopeRelation !== "intrinsic_requirement")
    ) return `advisory finding ${findingId} has contradictory fields`;
    if (
      (raw.category === "correctness" || raw.category === "security") &&
      (raw.severity === "critical" || raw.severity === "high")
    ) return `${raw.severity} ${raw.category} finding ${findingId} cannot be advisory`;
    if (!Array.isArray(raw.ruleIds) || raw.ruleIds.length === 0 || !allRulesHavePrefix(raw.ruleIds, "E-")) {
      return `advisory finding ${findingId} lacks an Elevated rule`;
    }
    return null;
  }

  return `finding ${findingId} has an unsupported kind`;
}

function structuralElevatedRules(facts: StructuralRiskFacts): ElevatedRuleId[] {
  const rules: ElevatedRuleId[] = [];
  for (const fact of Object.keys(STRUCTURAL_ELEVATED_RULES) as StructuralElevatedFact[]) {
    if (facts[fact]) rules.push(STRUCTURAL_ELEVATED_RULES[fact]);
  }
  return rules;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].toSorted();
}

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluation {
  const blocked: string[] = [];
  if (input.policyId !== RISK_POLICY_ID) blocked.push(`unsupported risk policy ${input.policyId}`);
  if (input.candidateHeadSha !== input.verifierCandidateHeadSha) blocked.push("Verifier evidence is stale for the Candidate");
  if (input.candidateHeadSha !== input.reviewerCandidateHeadSha) blocked.push("Reviewer evidence is stale for the Candidate");
  if (!input.sourceIdentityUnchanged) blocked.push("Candidate source identity changed after verification or review");
  if (!input.structural.complete) blocked.push("structural facts are incomplete");
  if (!input.structural.changedOnlyAllowedProductPaths) blocked.push("changed paths are outside the allowed product surface");
  if (!input.structural.acceptanceCriteriaCovered) blocked.push("acceptance-criterion coverage is incomplete");
  for (const dimension of dimensionNames) {
    if (!input.evidence[dimension]) blocked.push(`missing ${dimension} evidence`);
  }
  for (const finding of input.findings) {
    const error = validateFinding(finding);
    if (error !== null) blocked.push(error);
  }

  const findingProhibitedRules = uniqueSorted(input.findings.flatMap((finding) =>
    finding.kind === "intrinsic_prohibited" ? [...finding.ruleIds] : []
  ));
  for (const ruleId of input.reviewerProhibitedRuleIds) {
    if (!findingProhibitedRules.includes(ruleId)) {
      blocked.push(`Reviewer Prohibited rule ${ruleId} lacks a conclusive intrinsic or unavoidable finding`);
    }
  }
  for (const ruleId of findingProhibitedRules) {
    if (!input.reviewerProhibitedRuleIds.includes(ruleId)) {
      blocked.push(`conclusive Prohibited finding rule ${ruleId} is absent from the Reviewer classification`);
    }
  }

  if (blocked.length > 0) return { disposition: "blocked", reasons: uniqueSorted(blocked) };

  const prohibitedRules = uniqueSorted([
    ...input.structural.prohibitedRuleIds,
    ...findingProhibitedRules
  ]);
  if (prohibitedRules.length > 0) {
    if (input.reviewerClassification !== "prohibited") {
      return {
        disposition: "blocked",
        reasons: [`Reviewer classification ${input.reviewerClassification ?? "absent"} conflicts with policy result prohibited`]
      };
    }
    return { disposition: "review_complete", classification: "prohibited", ruleIds: prohibitedRules };
  }

  const repairFindings = input.findings.filter(
    (finding): finding is RepairableReviewFinding => finding.kind === "repairable"
  );
  if (repairFindings.length > 0) {
    if (input.reviewerClassification !== null) {
      return { disposition: "blocked", reasons: ["review_complete cannot retain a must-fix repairable finding"] };
    }
    return { disposition: "repair_required", findings: repairFindings };
  }

  const elevatedRules = uniqueSorted([
    ...structuralElevatedRules(input.structural),
    ...input.reviewerElevatedRuleIds,
    ...input.findings.flatMap((finding) => finding.kind === "advisory" ? [...finding.ruleIds] : [])
  ]);
  const computed: RiskClassification = elevatedRules.length > 0 ? "elevated" : "low";
  if (input.reviewerClassification !== computed) {
    return {
      disposition: "blocked",
      reasons: [`Reviewer classification ${input.reviewerClassification ?? "absent"} conflicts with policy result ${computed}`]
    };
  }
  if (computed === "elevated") {
    return { disposition: "review_complete", classification: "elevated", ruleIds: elevatedRules };
  }
  return { disposition: "review_complete", classification: "low", ruleIds: [] };
}
