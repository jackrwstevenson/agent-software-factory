declare const digestBrand: unique symbol;
declare const gitObjectIdBrand: unique symbol;
declare const factoryRunIdBrand: unique symbol;
declare const eventIdBrand: unique symbol;
declare const effectIntentIdBrand: unique symbol;
declare const issueIdBrand: unique symbol;
declare const authorizationIdBrand: unique symbol;
declare const stageAttemptIdBrand: unique symbol;

export type Digest = string & { readonly [digestBrand]: "Digest" };
export type GitObjectId = string & { readonly [gitObjectIdBrand]: "GitObjectId" };
export type FactoryRunId = string & { readonly [factoryRunIdBrand]: "FactoryRunId" };
export type EventId = string & { readonly [eventIdBrand]: "EventId" };
export type EffectIntentId = string & { readonly [effectIntentIdBrand]: "EffectIntentId" };
export type IssueId = string & { readonly [issueIdBrand]: "IssueId" };
export type AuthorizationId = string & { readonly [authorizationIdBrand]: "AuthorizationId" };
export type StageAttemptId = string & { readonly [stageAttemptIdBrand]: "StageAttemptId" };

function parseBranded<T extends string>(value: string, pattern: RegExp, name: string): T {
  if (!pattern.test(value)) throw new TypeError(`invalid ${name}: ${value}`);
  return value as T;
}

export function parseDigest(value: string): Digest {
  return parseBranded<Digest>(value, /^[0-9a-f]{64}$/, "SHA-256 digest");
}

export function parseGitObjectId(value: string): GitObjectId {
  return parseBranded<GitObjectId>(value, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Git object ID");
}

export function parseFactoryRunId(value: string): FactoryRunId {
  return parseBranded<FactoryRunId>(value, /^fr_[a-z0-9][a-z0-9_-]{2,63}$/, "Factory Run ID");
}


export function parseEventId(value: string): EventId {
  return parseBranded<EventId>(value, /^evt_[a-z0-9][a-z0-9_-]{2,63}$/, "event ID");
}

export function parseEffectIntentId(value: string): EffectIntentId {
  return parseBranded<EffectIntentId>(value, /^fx_[a-z0-9][a-z0-9_-]{2,63}$/, "effect intent ID");
}

export function parseIssueId(value: string): IssueId {
  return parseBranded<IssueId>(value, /^.{1,128}$/, "issue ID");
}

export function parseAuthorizationId(value: string): AuthorizationId {
  return parseBranded<AuthorizationId>(value, /^az_[a-z0-9][a-z0-9_-]{2,63}$/, "Authorization ID");
}

export function parseStageAttemptId(value: string): StageAttemptId {
  return parseBranded<StageAttemptId>(value, /^fa_[a-z0-9][a-z0-9_-]{2,63}$/, "Stage Attempt ID");
}

export type LifecycleState =
  | "building"
  | "verifying"
  | "reviewing"
  | "authorizing"
  | "awaiting_human_authorization"
  | "rolling_out"
  | "observing"
  | "rolling_back"
  | "paused_for_operator"
  | "succeeded"
  | "rejected"
  | "failed"
  | "rolled_back"
  | "aborted";
export type TerminalOutcome = "succeeded" | "rejected" | "failed" | "rolled_back" | "aborted";
export type RiskClassification = "low" | "elevated" | "prohibited";
export type Stage = "build" | "verify" | "review" | "authorize" | "rollout" | "observe";

export interface EffectInvocationContext {
  readonly effectIntentId: EffectIntentId;
  readonly factoryRunId: FactoryRunId;
}

export interface CandidateRelease {
  readonly schemaVersion: "1.0";
  readonly contract: "candidate_release";
  readonly factoryRunId: FactoryRunId;
  readonly candidateOrdinal: number;
  readonly builderStageAttemptId: StageAttemptId;
  readonly branchRef: string;
  readonly baseSha: GitObjectId;
  readonly headCommitSha: GitObjectId;
  readonly sourceTreeSha: GitObjectId;
}

export interface Authorization {
  readonly schemaVersion: "1.0";
  readonly contract: "authorization";
  readonly authorizationId: AuthorizationId;
  readonly kind: "autonomous_low" | "human";
  readonly decision: "authorized" | "rejected";
  readonly factoryRunId: FactoryRunId;
  readonly candidateHeadSha: GitObjectId;
  readonly riskClassification: "low" | "elevated";
  readonly recordedAt: string;
  readonly evidenceDigest: Digest;
}

export interface WorkerResult {
  readonly schemaVersion: "1.0";
  readonly contract: "worker_result";
  readonly role: "observer" | "rollout_babysitter";
  readonly factoryRunId: FactoryRunId;
  readonly candidateHeadSha: GitObjectId;
  readonly inputSha256: Digest;
  readonly decision:
    | "health_confirmed"
    | "incident_opened"
    | "incident_updated"
    | "incident_resolved"
    | "monitoring_gap"
    | "advance_to_rollout"
    | "advance_exposure"
    | "enter_observation"
    | "hold"
    | "rollback"
    | "pause"
    | "continue_observation"
    | "observation_passed"
    | "stable_confirmed";
  readonly facts: Readonly<{
    candidateExposureBasisPoints?: number;
    stableAvailable?: boolean;
    observationComplete?: boolean;
    telemetryPassed?: boolean;
    unresolvedIncidentCount?: number;
  }>;
}
