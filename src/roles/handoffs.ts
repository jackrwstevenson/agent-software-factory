import { canonicalJson, canonicalSha256 } from "../protocol/canonical-json.js";
import type { CandidateRelease, Digest, FactoryRunId } from "../protocol/contracts.js";
import type {
  AcceptedRoleResult,
  FactoryRole,
  HandoffManifest,
  HandoffParticipant,
  WireCandidateRelease
} from "./contracts.js";
import { RoleRuntimeError } from "./errors.js";
import { validateHandoffManifest } from "./schema-validation.js";

const HANDOFF_BINDINGS: Readonly<Record<HandoffManifest["kind"], Readonly<{
  source: HandoffParticipant;
  downstream: HandoffParticipant;
}>>> = {
  builder_to_verifier: { source: "builder", downstream: "verifier" },
  verifier_to_reviewer: { source: "verifier", downstream: "reviewer" },
  verifier_to_builder_repair: { source: "verifier", downstream: "builder" },
  reviewer_to_builder_repair: { source: "reviewer", downstream: "builder" },
  reviewer_to_authorize: { source: "reviewer", downstream: "authorize" },
  authorize_to_rollout: { source: "authorize", downstream: "rollout_babysitter" },
  rollout_decision: { source: "rollout_babysitter", downstream: "authorize" },
  observer_incident: { source: "observer", downstream: "rollout_babysitter" }
};

function wireCandidate(candidate: CandidateRelease): WireCandidateRelease {
  return {
    schema_version: candidate.schemaVersion,
    contract: candidate.contract,
    factory_run_id: candidate.factoryRunId,
    candidate_ordinal: candidate.candidateOrdinal,
    builder_stage_attempt_id: candidate.builderStageAttemptId,
    branch_ref: candidate.branchRef,
    base_sha: candidate.baseSha,
    head_commit_sha: candidate.headCommitSha,
    source_tree_sha: candidate.sourceTreeSha
  };
}

function verifyAcceptedSource(accepted: AcceptedRoleResult): Digest {
  const observed = canonicalSha256(accepted.result);
  if (accepted.result_sha256 !== observed) {
    throw new RoleRuntimeError("identity_mismatch", "accepted source result digest is not verifiable");
  }
  return observed;
}

export interface CreateHandoffInput {
  readonly handoffId: string;
  readonly kind: HandoffManifest["kind"];
  readonly accepted: AcceptedRoleResult;
  readonly candidate: CandidateRelease;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRefs?: readonly string[];
}

export function createHandoffManifest(input: CreateHandoffInput): Readonly<{
  manifest: HandoffManifest;
  sha256: Digest;
  canonicalJson: string;
}> {
  const binding = HANDOFF_BINDINGS[input.kind];
  if (binding.source !== input.accepted.result.role) {
    throw new RoleRuntimeError("identity_mismatch", `${input.kind} cannot originate from ${input.accepted.result.role}`);
  }
  if (input.accepted.result.factory_run_id !== input.candidate.factoryRunId) {
    throw new RoleRuntimeError("identity_mismatch", "accepted role result and Candidate belong to different Factory Runs");
  }
  if (
    input.accepted.result.candidate_head_sha !== null &&
    input.accepted.result.candidate_head_sha !== input.candidate.headCommitSha
  ) {
    throw new RoleRuntimeError("candidate_mismatch", "accepted role result is stale for the Handoff Candidate");
  }
  const sourceResultSha256 = verifyAcceptedSource(input.accepted);
  const manifest: HandoffManifest = {
    schema_version: "1.0",
    handoff_id: input.handoffId,
    kind: input.kind,
    factory_run_id: input.candidate.factoryRunId,
    source_role: binding.source,
    downstream: binding.downstream,
    source_stage_attempt_id: input.accepted.result.stage_attempt_id,
    source_result_sha256: sourceResultSha256,
    candidate: wireCandidate(input.candidate),
    created_at: input.createdAt,
    payload: input.payload,
    evidence_refs: input.evidenceRefs ?? input.accepted.result.evidence_claims
  };
  const validation = validateHandoffManifest(manifest);
  if (!validation.ok) {
    throw new RoleRuntimeError("schema_invalid", `invalid Handoff Manifest: ${validation.errors.join("; ")}`);
  }
  const encoded = canonicalJson(manifest);
  return { manifest, sha256: canonicalSha256(manifest), canonicalJson: encoded };
}

export function assertHandoffConsumable(input: Readonly<{
  manifest: HandoffManifest;
  factoryRunId: FactoryRunId;
  candidate: CandidateRelease;
  sourceAccepted: AcceptedRoleResult;
  downstream: FactoryRole | "authorize";
}>): HandoffManifest {
  const validation = validateHandoffManifest(input.manifest);
  if (!validation.ok) {
    throw new RoleRuntimeError("schema_invalid", `invalid Handoff Manifest: ${validation.errors.join("; ")}`);
  }
  const binding = HANDOFF_BINDINGS[input.manifest.kind];
  const sourceDigest = verifyAcceptedSource(input.sourceAccepted);
  if (
    input.manifest.factory_run_id !== input.factoryRunId ||
    input.candidate.factoryRunId !== input.factoryRunId ||
    input.manifest.source_role !== binding.source ||
    input.manifest.downstream !== binding.downstream ||
    input.manifest.downstream !== input.downstream ||
    input.sourceAccepted.result.role !== binding.source ||
    input.manifest.source_stage_attempt_id !== input.sourceAccepted.result.stage_attempt_id ||
    input.manifest.source_result_sha256 !== sourceDigest ||
    canonicalJson(input.manifest.candidate) !== canonicalJson(wireCandidate(input.candidate))
  ) {
    throw new RoleRuntimeError("identity_mismatch", "Handoff Manifest binding verification failed");
  }
  return input.manifest;
}
