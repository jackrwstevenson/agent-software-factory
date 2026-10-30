import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  createProcessAttemptIdentity,
  sameProcessAttemptIdentity
} from "../runtime/process-attempt-identity.js";
import type { ProcessAttemptIdentity, ProcessKind } from "../runtime/runtime-contracts.js";

export const TELEMETRY_EVENT_SCHEMA_VERSION = "telemetry-event/v1" as const;
export const TELEMETRY_WINDOW_SCHEMA_VERSION = "telemetry-window/v1" as const;
export const TELEMETRY_SUMMARY_SCHEMA_VERSION = "telemetry-window-summary/v1" as const;
export const OBSERVER_ASSESSMENT_SCHEMA_VERSION = "observer-assessment/v1" as const;
export const OBSERVER_RESULT_SCHEMA_VERSION = "observer-result/v1" as const;
export const BABYSITTER_PROPOSAL_SCHEMA_VERSION = "rollout-babysitter-proposal/v1" as const;

export type TelemetryPhase =
  | "staging"
  | "stable_reference"
  | "rollout"
  | "observation"
  | "rollback_confirmation";

export type RolloutGate =
  | "staging"
  | "stable_reference"
  | "gate_5"
  | "gate_10"
  | "gate_30"
  | "gate_50"
  | "gate_80"
  | "observation";

export type ComponentName = "stable" | "candidate" | "staging" | "router" | "traffic";
export type RequestArm = "stable" | "candidate";

export const TELEMETRY_EVENT_TYPES = Object.freeze([
  "routing_revision_applied",
  "telemetry_window_opened",
  "process_health_sampled",
  "process_exited",
  "request_started",
  "request_attempt_finished",
  "protocol_fault",
  "request_finished",
  "telemetry_window_closed"
] as const);
export type TelemetryEventType = typeof TELEMETRY_EVENT_TYPES[number];

export interface TelemetrySource {
  readonly kind: "orchestrator" | "supervisor" | "router" | "synthetic_traffic" | "release";
  readonly instanceId: string;
  readonly processAttempt: string;
  readonly sourceSequence: number;
}

export interface TelemetryEventBinding {
  readonly topologyEpoch: number;
  readonly routingRevisionId: string;
  readonly routingConfigFingerprint: string;
  readonly phase: TelemetryPhase;
  readonly gate: RolloutGate;
  readonly candidateBasisPoints: number;
  readonly stableReleaseId: string;
  readonly candidateReleaseId: string;
  readonly workloadId: string;
  readonly workloadDigest: string;
  readonly policyId: string;
}

export interface ProcessIdentity extends ProcessAttemptIdentity {
  readonly endpointId: string;
}

const PROCESS_KIND_BY_COMPONENT: Readonly<Record<ComponentName, ProcessKind>> = Object.freeze({
  stable: "stable_release",
  candidate: "candidate_release",
  staging: "staging_release",
  router: "router",
  traffic: "synthetic_traffic"
});

const COMPONENT_BY_PROCESS_KIND: Readonly<Record<ProcessKind, ComponentName>> = Object.freeze({
  stable_release: "stable",
  candidate_release: "candidate",
  staging_release: "staging",
  router: "router",
  synthetic_traffic: "traffic"
});

export function processKindForComponent(component: ComponentName): ProcessKind {
  return PROCESS_KIND_BY_COMPONENT[component];
}

export function componentForProcessIdentity(identity: ProcessAttemptIdentity): ComponentName {
  return COMPONENT_BY_PROCESS_KIND[identity.processKind];
}

export function processIdentity(identity: ProcessIdentity): ProcessIdentity {
  const canonical = createProcessAttemptIdentity(identity);
  if (identity.endpointId.length === 0) throw new TypeError("endpointId must not be empty");
  return Object.freeze({ ...canonical, endpointId: identity.endpointId });
}

export function sameTelemetryProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return sameProcessAttemptIdentity(left, right) && left.endpointId === right.endpointId;
}

export interface TelemetryWindowBinding extends TelemetryEventBinding {
  readonly schemaVersion: typeof TELEMETRY_WINDOW_SCHEMA_VERSION;
  readonly factoryRunId: string;
  readonly windowId: string;
  readonly requestedIntervalMs: number;
  readonly collectionDeadlineMs: number;
  readonly components: Readonly<Partial<Record<ComponentName, ProcessIdentity>>>;
  readonly requiredComponents: readonly ComponentName[];
  readonly sourceCursorsAtOpen: Readonly<Record<string, number>>;
  readonly pinnedStableReferenceWindowId: string | null;
  readonly bindingDigest: string;
}

export interface RoutingRevisionAppliedPayload {
  readonly observedFingerprint: string;
  readonly revisionManifest: Readonly<Record<string, unknown>>;
}

export interface TelemetryWindowOpenedPayload {
  readonly binding: TelemetryWindowBinding;
  readonly bindingDigest: string;
}

export interface ProcessHealthSampledPayload {
  readonly component: ProcessIdentity;
  readonly healthy: boolean;
  readonly reason: string | null;
  readonly reportedRoutingRevisionId: string | null;
}

export interface ProcessExitedPayload {
  readonly component: ProcessIdentity;
  readonly expected: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface RequestStartedPayload {
  readonly requestId: string;
  readonly userId: string;
  readonly operationId: string;
  readonly bucket: number;
  readonly selectedArm: RequestArm;
  readonly selectedComponent: ProcessIdentity;
}

export type RequestAttemptOutcome =
  | "success"
  | "http_error"
  | "timeout"
  | "unavailable"
  | "identity_mismatch"
  | "router_error";

export interface RequestAttemptFinishedPayload {
  readonly requestId: string;
  readonly attemptOrdinal: number;
  readonly selectedArm: RequestArm;
  readonly selectedComponent: ProcessIdentity;
  readonly outcome: RequestAttemptOutcome;
  readonly statusCode: number | null;
  readonly attemptLatencyMs: number;
  readonly responseIdentityVerified: boolean;
}

export interface ProtocolFaultPayload {
  readonly condition: string;
  readonly selectedArm?: RequestArm;
  readonly requestId?: string;
}

export interface RequestFinishedPayload {
  readonly requestId: string;
  readonly selectedArm: RequestArm;
  readonly selectedComponent: ProcessIdentity;
  readonly finalOutcome: "success" | "failed";
  readonly attemptCount: number;
  readonly durationMs: number;
  readonly failureKind: string | null;
  readonly responseIdentityVerified: boolean;
}

export interface TelemetryWindowClosedPayload {
  readonly bindingDigest: string;
  readonly reason: string;
  readonly inFlightRequests: number;
  readonly sourceCursorsAtClose: Readonly<Record<string, number>>;
}

export interface TelemetryEventPayloadMap {
  readonly routing_revision_applied: RoutingRevisionAppliedPayload;
  readonly telemetry_window_opened: TelemetryWindowOpenedPayload;
  readonly process_health_sampled: ProcessHealthSampledPayload;
  readonly process_exited: ProcessExitedPayload;
  readonly request_started: RequestStartedPayload;
  readonly request_attempt_finished: RequestAttemptFinishedPayload;
  readonly protocol_fault: ProtocolFaultPayload;
  readonly request_finished: RequestFinishedPayload;
  readonly telemetry_window_closed: TelemetryWindowClosedPayload;
}

interface TelemetryEventBase<K extends TelemetryEventType> {
  readonly schemaVersion: typeof TELEMETRY_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly factoryRunId: string;
  readonly occurredAt: string;
  readonly monotonicMs: number;
  readonly source: TelemetrySource;
  readonly windowId: string;
  readonly eventType: K;
  readonly binding: TelemetryEventBinding;
  readonly payloadDigest: string;
  readonly payload: Readonly<TelemetryEventPayloadMap[K]>;
}

export type TelemetryEventInput = {
  readonly [K in TelemetryEventType]: TelemetryEventBase<K>
}[TelemetryEventType];

export type TelemetryEventOf<K extends TelemetryEventType> = Extract<TelemetryEventInput, { readonly eventType: K }>;

export type TelemetryEventDraft<K extends TelemetryEventType> = Omit<
  TelemetryEventOf<K>,
  "schemaVersion" | "payloadDigest"
> & {
  readonly schemaVersion?: typeof TELEMETRY_EVENT_SCHEMA_VERSION;
  readonly payloadDigest?: string;
};

interface AcceptedMetadata {
  readonly ingestSequence: number;
  readonly ingestedAt: string;
  readonly sourceEventDigest: string;
}

export type AcceptedTelemetryEvent = {
  readonly [K in TelemetryEventType]: TelemetryEventOf<K> & AcceptedMetadata
}[TelemetryEventType];
export type AcceptedTelemetryEventOf<K extends TelemetryEventType> = Extract<
  AcceptedTelemetryEvent,
  { readonly eventType: K }
>;

export interface TelemetryProtocolConflict {
  readonly windowId: string;
  readonly eventId: string;
  readonly sourceIdentity: string;
  readonly existingDigest: string;
  readonly conflictingDigest: string;
}

export function createTelemetryEvent<K extends TelemetryEventType>(draft: TelemetryEventDraft<K>): TelemetryEventOf<K> {
  const payloadDigest = canonicalSha256(draft.payload);
  if (draft.payloadDigest !== undefined && draft.payloadDigest !== payloadDigest) {
    throw new TypeError(`payload digest mismatch for ${draft.eventId}`);
  }
  return Object.freeze({
    schemaVersion: TELEMETRY_EVENT_SCHEMA_VERSION,
    eventId: draft.eventId,
    factoryRunId: draft.factoryRunId,
    occurredAt: draft.occurredAt,
    monotonicMs: draft.monotonicMs,
    source: Object.freeze({ ...draft.source }),
    windowId: draft.windowId,
    eventType: draft.eventType,
    binding: Object.freeze({ ...draft.binding }),
    payloadDigest,
    payload: Object.freeze(structuredClone(draft.payload))
  }) as unknown as TelemetryEventOf<K>;
}

export function telemetrySourceBaseKey(source: TelemetrySource): string {
  return `${source.kind}|${source.instanceId}|${source.processAttempt}`;
}

export function telemetrySourceIdentityKey(source: TelemetrySource): string {
  return `${telemetrySourceBaseKey(source)}|${source.sourceSequence}`;
}

export function eventBindingFromWindow(binding: TelemetryWindowBinding): TelemetryEventBinding {
  return Object.freeze({
    topologyEpoch: binding.topologyEpoch,
    routingRevisionId: binding.routingRevisionId,
    routingConfigFingerprint: binding.routingConfigFingerprint,
    phase: binding.phase,
    gate: binding.gate,
    candidateBasisPoints: binding.candidateBasisPoints,
    stableReleaseId: binding.stableReleaseId,
    candidateReleaseId: binding.candidateReleaseId,
    workloadId: binding.workloadId,
    workloadDigest: binding.workloadDigest,
    policyId: binding.policyId
  });
}

export type TelemetryWindowBindingDraft = Omit<
  TelemetryWindowBinding,
  "schemaVersion" | "bindingDigest"
> & { readonly schemaVersion?: typeof TELEMETRY_WINDOW_SCHEMA_VERSION; readonly bindingDigest?: string };

export function createTelemetryWindowBinding(draft: TelemetryWindowBindingDraft): TelemetryWindowBinding {
  const withoutDigest = {
    schemaVersion: TELEMETRY_WINDOW_SCHEMA_VERSION,
    factoryRunId: draft.factoryRunId,
    windowId: draft.windowId,
    topologyEpoch: draft.topologyEpoch,
    routingRevisionId: draft.routingRevisionId,
    routingConfigFingerprint: draft.routingConfigFingerprint,
    phase: draft.phase,
    gate: draft.gate,
    candidateBasisPoints: draft.candidateBasisPoints,
    stableReleaseId: draft.stableReleaseId,
    candidateReleaseId: draft.candidateReleaseId,
    workloadId: draft.workloadId,
    workloadDigest: draft.workloadDigest,
    policyId: draft.policyId,
    requestedIntervalMs: draft.requestedIntervalMs,
    collectionDeadlineMs: draft.collectionDeadlineMs,
    components: structuredClone(draft.components),
    requiredComponents: [...draft.requiredComponents],
    sourceCursorsAtOpen: structuredClone(draft.sourceCursorsAtOpen),
    pinnedStableReferenceWindowId: draft.pinnedStableReferenceWindowId
  } as const;
  const bindingDigest = canonicalSha256(withoutDigest);
  if (draft.bindingDigest !== undefined && draft.bindingDigest !== bindingDigest) {
    throw new TypeError(`window binding digest mismatch for ${draft.windowId}`);
  }
  return Object.freeze({ ...withoutDigest, bindingDigest });
}
