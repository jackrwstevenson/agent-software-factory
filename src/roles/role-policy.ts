import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import builderResultSchema from "../../schemas/v1/role-builder-result.schema.json" with { type: "json" };
import reviewerResultSchema from "../../schemas/v1/role-reviewer-result.schema.json" with { type: "json" };
import sharedResultSchema from "../../schemas/v1/role-result.schema.json" with { type: "json" };
import verifierResultSchema from "../../schemas/v1/role-verifier-result.schema.json" with { type: "json" };
import { parseDigest, parseGitObjectId, parseStageAttemptId } from "../protocol/contracts.js";
import type { BuilderResult, ReviewerResult, VerifierResult } from "./port.js";
import type {
  AcceptedRoleResult,
  BuilderRoleResult,
  FactoryRole,
  ReviewerRoleResult,
  RoleInputManifest,
  RoleResult,
  VerifierRoleResult
} from "./contracts.js";
import { RoleRuntimeError } from "./errors.js";

export type RoleResultFor<R extends FactoryRole> = R extends "builder"
  ? BuilderRoleResult
  : R extends "verifier"
    ? VerifierRoleResult
    : ReviewerRoleResult;

export type LegacyResultFor<R extends FactoryRole> = R extends "builder"
  ? BuilderResult
  : R extends "verifier"
    ? VerifierResult
    : ReviewerResult;

export interface FactoryRolePolicy<R extends FactoryRole> {
  readonly role: R;
  readonly lifecycleState: R extends "builder" ? "building" : R extends "verifier" ? "verifying" : "reviewing";
  readonly sandbox: R extends "builder" ? "workspace-write" : "read-only";
  readonly successDecision: RoleResultFor<R>["decision"];
  readonly schema: object;
  readonly validate: (value: unknown) => RoleValidation<RoleResultFor<R>>;
  readonly validateSemantics: (input: RoleInputManifest, result: RoleResultFor<R>) => void;
  readonly adaptLegacyResult: (accepted: AcceptedRoleResult<RoleResultFor<R>>) => LegacyResultFor<R>;
}

export type RoleValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(sharedResultSchema);
for (const schema of [builderResultSchema, verifierResultSchema, reviewerResultSchema]) ajv.addSchema(schema);

function formatError(error: ErrorObject): string {
  const location = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  const extra =
    typeof error.params === "object" && "additionalProperty" in error.params
      ? `: ${String(error.params.additionalProperty)}`
      : "";
  return `${location} ${error.message ?? error.keyword}${extra}`;
}

function validator<T>(schemaId: string): (value: unknown) => RoleValidation<T> {
  const validate = ajv.getSchema(schemaId) as ValidateFunction;
  return (value) => {
    if (validate(value)) return { ok: true, value: value as T };
    return { ok: false, errors: (validate.errors ?? []).map(formatError) };
  };
}

function validateBuilderSemantics(input: RoleInputManifest, result: BuilderRoleResult): void {
  if (result.decision === "changes_ready") {
    const addressed = new Map(result.role_result.criteria.map((item) => [item.criterion, item.status]));
    if (
      result.role_result.changed_paths.length === 0 ||
      result.role_result.demonstration_summary.trim() === "" ||
      result.role_result.blocker !== null ||
      input.issue.acceptance_criteria.some((criterion) => addressed.get(criterion) !== "addressed")
    ) {
      throw new RoleRuntimeError("worker_protocol_error", "Builder changes_ready evidence is incomplete");
    }
  } else if (result.role_result.blocker === null) {
    throw new RoleRuntimeError("worker_protocol_error", "blocked Builder result requires a typed blocker");
  }
}

function validateVerifierSemantics(input: RoleInputManifest, result: VerifierRoleResult): void {
  if (result.decision !== "passed") return;
  const verified = new Map(result.role_result.criteria.map((item) => [item.criterion, item.status]));
  const requiredCommands = (input.role_payload.required_commands ?? []) as readonly string[];
  const checks = new Map(result.role_result.checks.map((item) => [item.command, item.status]));
  if (
    result.role_result.findings.length !== 0 ||
    result.role_result.blocker !== null ||
    input.issue.acceptance_criteria.some((criterion) => verified.get(criterion) !== "passed") ||
    requiredCommands.some((command) => checks.get(command) !== "passed")
  ) {
    throw new RoleRuntimeError("worker_protocol_error", "Verifier passed without complete independent evidence");
  }
}

function validateReviewerSemantics(_input: RoleInputManifest, result: ReviewerRoleResult): void {
  if (result.decision === "review_complete") {
    if (result.role_result.risk_classification === null || result.role_result.blocker !== null) {
      throw new RoleRuntimeError("worker_protocol_error", "review_complete requires Risk Classification and no blocker");
    }
  } else if (result.role_result.risk_classification !== null) {
    throw new RoleRuntimeError("worker_protocol_error", "incomplete review cannot classify release risk");
  }
}

const builderPolicy: FactoryRolePolicy<"builder"> = {
  role: "builder",
  lifecycleState: "building",
  sandbox: "workspace-write",
  successDecision: "changes_ready",
  schema: builderResultSchema,
  validate: validator<BuilderRoleResult>(builderResultSchema.$id),
  validateSemantics: validateBuilderSemantics,
  adaptLegacyResult(accepted) {
    return {
      decision: "changes_ready",
      stageAttemptId: parseStageAttemptId(accepted.result.stage_attempt_id),
      builderEvidenceDigest: parseDigest(accepted.evidence_digest),
      summary: accepted.result.summary
    };
  }
};

const verifierPolicy: FactoryRolePolicy<"verifier"> = {
  role: "verifier",
  lifecycleState: "verifying",
  sandbox: "read-only",
  successDecision: "passed",
  schema: verifierResultSchema,
  validate: validator<VerifierRoleResult>(verifierResultSchema.$id),
  validateSemantics: validateVerifierSemantics,
  adaptLegacyResult(accepted) {
    return {
      decision: "passed",
      candidateHeadSha: parseGitObjectId(accepted.result.candidate_head_sha),
      evidenceDigest: parseDigest(accepted.evidence_digest)
    };
  }
};

const reviewerPolicy: FactoryRolePolicy<"reviewer"> = {
  role: "reviewer",
  lifecycleState: "reviewing",
  sandbox: "read-only",
  successDecision: "review_complete",
  schema: reviewerResultSchema,
  validate: validator<ReviewerRoleResult>(reviewerResultSchema.$id),
  validateSemantics: validateReviewerSemantics,
  adaptLegacyResult(accepted) {
    const classification = accepted.result.role_result.risk_classification;
    if (classification === null) {
      throw new RoleRuntimeError("worker_protocol_error", "accepted Reviewer result has no Risk Classification");
    }
    return {
      decision: "review_complete",
      review: {
        candidateHeadSha: parseGitObjectId(accepted.result.candidate_head_sha),
        disposition: "review_complete",
        riskClassification: classification,
        evidenceDigest: parseDigest(accepted.evidence_digest)
      }
    };
  }
};

export const FACTORY_ROLE_POLICIES = {
  builder: builderPolicy,
  verifier: verifierPolicy,
  reviewer: reviewerPolicy
} as const satisfies { readonly [R in FactoryRole]: FactoryRolePolicy<R> };

export function rolePolicy<R extends FactoryRole>(role: R): FactoryRolePolicy<R> {
  return FACTORY_ROLE_POLICIES[role] as FactoryRolePolicy<R>;
}

export function validateRoleResult<R extends FactoryRole>(role: R, value: unknown): RoleValidation<RoleResultFor<R>> {
  return rolePolicy(role).validate(value);
}

export function isRoleResult(value: unknown): value is RoleResult {
  if (typeof value !== "object" || value === null || !("role" in value)) return false;
  const role = (value as { role?: unknown }).role;
  if (role !== "builder" && role !== "verifier" && role !== "reviewer") return false;
  return validateRoleResult(role, value).ok;
}
