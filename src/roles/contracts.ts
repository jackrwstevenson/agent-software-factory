import type {
  CandidateRelease,
  Digest,
  FactoryRunId,
  GitObjectId,
  LifecycleState,
  RiskClassification,
  StageAttemptId
} from "../protocol/contracts.js";

export type FactoryRole = "builder" | "verifier" | "reviewer";
export type RoleCancellationReason =
  | "timeout"
  | "human_abort"
  | "safety_rollback"
  | "superseded_candidate"
  | "orchestrator_shutdown"
  | "protocol_violation"
  | "evidence_limit_exceeded"
  | "operator_request";

export type RoleTechnicalOutcome =
  | "spawn_failed"
  | "nonzero_exit"
  | "signalled"
  | "timed_out"
  | "cancelled"
  | "evidence_limit_exceeded"
  | "missing_turn_completion"
  | "missing_result"
  | "invalid_json"
  | "schema_invalid"
  | "identity_mismatch"
  | "candidate_mismatch"
  | "stale_input"
  | "unauthorized_write"
  | "forbidden_path_change"
  | "worktree_not_clean"
  | "child_process_leak"
  | "unsupported_write_requirement"
  | "worker_protocol_error";

export interface RoleInputIssue {
  readonly issue_id: string;
  readonly number: number;
  readonly title: string;
  readonly acceptance_criteria: readonly string[];
  readonly url: string;
  readonly created_at: string;
}

export interface WireCandidateRelease {
  readonly schema_version: "1.0";
  readonly contract: "candidate_release";
  readonly factory_run_id: string;
  readonly candidate_ordinal: number;
  readonly builder_stage_attempt_id: string;
  readonly branch_ref: string;
  readonly base_sha: string;
  readonly head_commit_sha: string;
  readonly source_tree_sha: string;
}

export type HandoffParticipant = FactoryRole | "authorize" | "rollout_babysitter" | "observer";

export interface HandoffManifest {
  readonly schema_version: "1.0";
  readonly handoff_id: string;
  readonly kind:
    | "builder_to_verifier"
    | "verifier_to_reviewer"
    | "verifier_to_builder_repair"
    | "reviewer_to_builder_repair"
    | "reviewer_to_authorize"
    | "authorize_to_rollout"
    | "rollout_decision"
    | "observer_incident";
  readonly factory_run_id: string;
  readonly source_role: HandoffParticipant;
  readonly downstream: HandoffParticipant;
  readonly source_stage_attempt_id: string;
  readonly source_result_sha256: string;
  readonly candidate: WireCandidateRelease;
  readonly created_at: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidence_refs: readonly string[];
}

export interface RoleInputManifest {
  readonly schema_version: "1.0";
  readonly contract: "role_input";
  readonly role: FactoryRole;
  readonly factory_run_id: string;
  readonly stage_attempt_id: string;
  readonly invocation_id: string;
  readonly lifecycle_state: Extract<LifecycleState, "building" | "verifying" | "reviewing">;
  readonly stage_attempt_ordinal: number;
  readonly issued_at: string;
  readonly deadline_at: string;
  readonly wall_clock_limit_ms: number;
  readonly issue: RoleInputIssue;
  readonly source: Readonly<{
    worktree_path: string;
    branch_ref: string;
    base_sha: string;
    candidate: WireCandidateRelease | null;
  }>;
  readonly instructions: readonly string[];
  readonly policy_refs: readonly Readonly<{ policy_id: string; sha256: string }>[];
  readonly prior_handoffs: readonly HandoffManifest[];
  readonly role_payload: Readonly<Record<string, unknown>>;
}

export interface CommonRoleResult {
  readonly schema_version: "1.0";
  readonly contract: "role_result";
  readonly role: FactoryRole;
  readonly factory_run_id: string;
  readonly stage_attempt_id: string;
  readonly invocation_id: string;
  readonly input_sha256: string;
  readonly candidate_head_sha: string | null;
  readonly decision: string;
  readonly summary: string;
  readonly evidence_claims: readonly string[];
  readonly unresolved_risks: readonly string[];
  readonly role_result: Readonly<Record<string, unknown>>;
}

export interface BuilderRoleResult extends CommonRoleResult {
  readonly role: "builder";
  readonly candidate_head_sha: null;
  readonly decision: "changes_ready" | "blocked";
  readonly role_result: Readonly<{
    changed_paths: readonly string[];
    criteria: readonly Readonly<{
      criterion: string;
      status: "addressed" | "not_addressed";
      evidence_claims: readonly string[];
    }>[];
    commands: readonly Readonly<{
      command: string;
      status: "passed" | "failed" | "not_run";
      evidence_claims: readonly string[];
    }>[];
    demonstration_summary: string;
    blocker: Readonly<{ code: string; detail: string }> | null;
  }>;
}

export interface VerifierRoleResult extends CommonRoleResult {
  readonly role: "verifier";
  readonly candidate_head_sha: string;
  readonly decision: "passed" | "repair_required" | "blocked";
  readonly role_result: Readonly<{
    checks: readonly Readonly<{
      command: string;
      status: "passed" | "failed" | "not_run";
      evidence_claims: readonly string[];
    }>[];
    criteria: readonly Readonly<{
      criterion: string;
      status: "passed" | "failed" | "blocked";
      evidence_claims: readonly string[];
    }>[];
    findings: readonly Readonly<Record<string, unknown>>[];
    blocker: Readonly<{ code: string; detail: string }> | null;
  }>;
}

export interface ReviewerRoleResult extends CommonRoleResult {
  readonly role: "reviewer";
  readonly candidate_head_sha: string;
  readonly decision: "review_complete" | "repair_required" | "blocked";
  readonly role_result: Readonly<{
    findings: readonly Readonly<Record<string, unknown>>[];
    correctness_assessment: string;
    security_assessment: string;
    risk_factors: readonly Readonly<Record<string, unknown>>[];
    risk_classification: RiskClassification | null;
    blocker: Readonly<{ code: string; detail: string }> | null;
  }>;
}

export type RoleResult = BuilderRoleResult | VerifierRoleResult | ReviewerRoleResult;

export interface RoleProcessEvidence {
  readonly executable_path: string;
  readonly executable_sha256: string;
  readonly version: string;
  readonly pid: number;
  readonly pgid: number;
  readonly birth_identity: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cancellation_reason: RoleCancellationReason | null;
  readonly process_group_absent: boolean;
  readonly events_sha256: string;
  readonly events_bytes: number;
  readonly stderr_sha256: string;
  readonly stderr_bytes: number;
}

export interface RolePostconditions {
  readonly role: FactoryRole;
  readonly candidate_head_sha: string | null;
  readonly changed_paths: readonly string[];
  readonly git_head_unchanged: boolean;
  readonly git_refs_unchanged: boolean;
  readonly git_index_unchanged: boolean;
  readonly source_tree_unchanged: boolean;
  readonly forbidden_paths_unchanged: boolean;
  readonly diff_check_passed: boolean;
  readonly process_group_absent: boolean;
}

export interface AcceptedRoleResult<R extends RoleResult = RoleResult> {
  readonly schema_version: "1.0";
  readonly contract: "accepted_role_result";
  readonly accepted_at: string;
  readonly input_sha256: string;
  readonly result_sha256: string;
  readonly evidence_digest: string;
  readonly result: R;
  readonly postconditions: RolePostconditions;
  readonly process: RoleProcessEvidence;
}

export interface RoleInvocationRequest<R extends FactoryRole = FactoryRole> {
  readonly role: R;
  readonly factoryRunId: FactoryRunId;
  readonly stageAttemptId: StageAttemptId;
  readonly invocationId: string;
  readonly lifecycleState: Extract<LifecycleState, "building" | "verifying" | "reviewing">;
  readonly stageAttemptOrdinal: number;
  readonly issue: RoleInputIssue;
  readonly worktreePath: string;
  readonly branchRef: string;
  readonly baseSha: GitObjectId;
  readonly candidate: CandidateRelease | null;
  readonly instructions: readonly string[];
  readonly policyRefs: readonly Readonly<{ policy_id: string; sha256: Digest }>[];
  readonly priorHandoffs: readonly HandoffManifest[];
  readonly priorAcceptedResults?: readonly AcceptedRoleResult[];
  readonly rolePayload: Readonly<Record<string, unknown>>;
  readonly wallClockLimitMs?: number;
  readonly signal?: AbortSignal;
  readonly cancellationReason?: Exclude<RoleCancellationReason, "timeout" | "evidence_limit_exceeded">;
}

export interface RoleRuntimePreflight {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly version: "codex-cli 0.154.0";
  readonly authenticated: true;
  readonly codexHome: string;
  readonly capabilities: Readonly<{
    ephemeral: boolean;
    strictConfig: boolean;
    sandbox: boolean;
    isolatedScratch: boolean;
    jsonEvents: boolean;
    outputSchema: boolean;
    outputLastMessage: boolean;
    commandNetworkDenied: boolean;
    commandLoopbackDenied: boolean;
    commandEnvironmentFiltered: boolean;
    outsideRootWritesDenied: boolean;
    protectedControlWritesDenied: boolean;
    authLocationDenied: boolean;
    publicNetworkDenied: boolean;
    loopbackNetworkDenied: boolean;
    privilegedDescriptorsDenied: boolean;
    unsupportedVerificationWritesDetected: boolean;
    cancellationTreeKilled: boolean;
  }>;
}

export interface CandidateBinding {
  readonly factoryRunId: FactoryRunId;
  readonly candidateHeadSha: GitObjectId;
}
