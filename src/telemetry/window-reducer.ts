import { canonicalJson, canonicalSha256 } from "../protocol/canonical-json.js";
import { AcceptedEventJournal } from "./accepted-event-journal.js";
import {
  TELEMETRY_SUMMARY_SCHEMA_VERSION,
  telemetrySourceBaseKey,
  type AcceptedTelemetryEvent,
  type AcceptedTelemetryEventOf,
  type ComponentName,
  componentForProcessIdentity,
  sameTelemetryProcessIdentity,
  type ProcessIdentity,
  type RequestArm,
  type TelemetryEventType,
  type TelemetryWindowBinding
} from "./contracts.js";
import { ROLLOUT_POLICY_V1, gatePolicy, type ArmEvidenceFloor } from "./rollout-policy.js";

export type WindowCompleteness =
  | "complete"
  | "incomplete_gap"
  | "incomplete_interrupted"
  | "invalid_conflict"
  | "stale";

export interface ArmMetrics {
  readonly logicalRequestsAssigned: number;
  readonly logicalRequestsDispatched: number;
  readonly logicalRequestsFinished: number;
  readonly successes: number;
  readonly finalFailures: number;
  readonly interrupted: number;
  readonly protocolFaults: number;
  readonly uniqueAssignedUsers: number;
  readonly uniqueFinishedUsers: number;
  readonly attempts: number;
  readonly retries: number;
  readonly attemptOutcomes: Readonly<Record<string, number>>;
  readonly retryRate: number | null;
  readonly nonSuccessAttemptRate: number | null;
  readonly exactReleaseResponses: number;
  readonly latencySampleCount: number;
  readonly latencyMinimumMs: number | null;
  readonly latencyMaximumMs: number | null;
  readonly latencySumMs: number;
  readonly latencyMedianMs: number | null;
  readonly latencyP95Ms: number | null;
}

export type ComponentHealthState = "healthy" | "degraded" | "unhealthy" | "unknown_due_to_gap";

export interface ComponentHealthSummary {
  readonly component: ComponentName;
  readonly state: ComponentHealthState;
  readonly expectedSamples: number;
  readonly samples: number;
  readonly healthySamples: number;
  readonly failedSamples: number;
  readonly identityMismatches: number;
  readonly longestConsecutiveFailures: number;
  readonly endingConsecutiveHealthy: number;
  readonly processExits: number;
  readonly routingRevisionMismatches: number;
  readonly reasons: readonly string[];
}

export interface TelemetryWindowSummary {
  readonly schemaVersion: typeof TELEMETRY_SUMMARY_SCHEMA_VERSION;
  readonly factoryRunId: string;
  readonly windowId: string;
  readonly binding: TelemetryWindowBinding;
  readonly acceptedEventStart: number;
  readonly acceptedEventEnd: number;
  readonly acceptedEventDigest: string;
  readonly elapsedMs: number;
  readonly completeness: WindowCompleteness;
  readonly completenessReasons: readonly string[];
  readonly sourceGaps: readonly Readonly<{ sourceKey: string; expected: readonly number[]; actual: readonly number[] }>[];
  readonly metrics: Readonly<Record<RequestArm, ArmMetrics>>;
  readonly health: Readonly<Partial<Record<ComponentName, ComponentHealthSummary>>>;
  readonly processExitObserved: boolean;
  readonly responseIdentityMismatchObserved: boolean;
  readonly windowDigest: string;
}

export interface ArmSufficiency {
  readonly required: boolean;
  readonly finishedRequestsSatisfied: boolean;
  readonly uniqueFinishedUsersSatisfied: boolean;
  readonly actualFinishedRequests: number;
  readonly actualUniqueFinishedUsers: number;
  readonly minimumFinishedRequests: number;
  readonly minimumUniqueFinishedUsers: number;
}

export interface SufficiencyAssessment {
  readonly state:
    | "complete_sufficient"
    | "complete_insufficient_duration"
    | "complete_insufficient_samples"
    | "not_evaluated";
  readonly durationSatisfied: boolean;
  readonly actualDurationMs: number;
  readonly minimumDurationMs: number;
  readonly stable: ArmSufficiency;
  readonly candidate: ArmSufficiency;
}

export interface ReduceWindowOptions {
  readonly activeTopologyEpoch?: number;
  readonly activeRoutingRevisionId?: string;
  readonly activeCandidateReleaseId?: string;
  readonly activePolicyId?: string;
  readonly throughIngestSequence?: number;
}

interface ArmAccumulator {
  assigned: number;
  dispatched: number;
  finished: number;
  successes: number;
  finalFailures: number;
  protocolFaults: number;
  exactReleaseResponses: number;
  attempts: number;
  nonSuccessAttempts: number;
  usersAssigned: Set<string>;
  usersFinished: Set<string>;
  durations: number[];
  attemptOutcomes: Record<string, number>;
}

interface RequestAccumulator {
  readonly requestId: string;
  readonly userId: string;
  readonly arm: RequestArm;
  attempts: number;
  finished: boolean;
}

interface HealthAccumulator {
  readonly component: ComponentName;
  samples: number;
  healthySamples: number;
  failedSamples: number;
  identityMismatches: number;
  currentFailures: number;
  longestFailures: number;
  endingHealthy: number;
  processExits: number;
  routingRevisionMismatches: number;
  reasons: Set<string>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value as number;
}

function percentileNearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)] ?? null;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function newArm(): ArmAccumulator {
  return {
    assigned: 0,
    dispatched: 0,
    finished: 0,
    successes: 0,
    finalFailures: 0,
    protocolFaults: 0,
    exactReleaseResponses: 0,
    attempts: 0,
    nonSuccessAttempts: 0,
    usersAssigned: new Set<string>(),
    usersFinished: new Set<string>(),
    durations: [],
    attemptOutcomes: {}
  };
}

function finishArm(value: ArmAccumulator): ArmMetrics {
  const retries = Math.max(0, value.attempts - value.finished);
  return Object.freeze({
    logicalRequestsAssigned: value.assigned,
    logicalRequestsDispatched: value.dispatched,
    logicalRequestsFinished: value.finished,
    successes: value.successes,
    finalFailures: value.finalFailures,
    interrupted: Math.max(0, value.assigned - value.finished),
    protocolFaults: value.protocolFaults,
    uniqueAssignedUsers: value.usersAssigned.size,
    uniqueFinishedUsers: value.usersFinished.size,
    attempts: value.attempts,
    retries,
    attemptOutcomes: Object.freeze({ ...value.attemptOutcomes }),
    retryRate: value.finished === 0 ? null : rounded(retries / value.finished),
    nonSuccessAttemptRate: value.attempts === 0 ? null : rounded(value.nonSuccessAttempts / value.attempts),
    exactReleaseResponses: value.exactReleaseResponses,
    latencySampleCount: value.durations.length,
    latencyMinimumMs: value.durations.length === 0 ? null : Math.min(...value.durations),
    latencyMaximumMs: value.durations.length === 0 ? null : Math.max(...value.durations),
    latencySumMs: value.durations.reduce((sum, duration) => sum + duration, 0),
    latencyMedianMs: percentileNearestRank(value.durations, 0.5),
    latencyP95Ms: percentileNearestRank(value.durations, 0.95)
  });
}

function newHealth(component: ComponentName): HealthAccumulator {
  return {
    component,
    samples: 0,
    healthySamples: 0,
    failedSamples: 0,
    identityMismatches: 0,
    currentFailures: 0,
    longestFailures: 0,
    endingHealthy: 0,
    processExits: 0,
    routingRevisionMismatches: 0,
    reasons: new Set<string>()
  };
}

function finishHealth(value: HealthAccumulator, expectedSamples: number): ComponentHealthSummary {
  let state: ComponentHealthState;
  if (value.processExits > 0 || value.identityMismatches > 0 || value.routingRevisionMismatches > 0) {
    state = "unhealthy";
  } else if (value.samples < expectedSamples) {
    state = "unknown_due_to_gap";
  } else if (value.longestFailures >= ROLLOUT_POLICY_V1.health.unhealthyConsecutiveFailures) {
    state = "unhealthy";
  } else if (value.failedSamples > 0) {
    state = "degraded";
  } else {
    state = "healthy";
  }
  return Object.freeze({
    component: value.component,
    state,
    expectedSamples,
    samples: value.samples,
    healthySamples: value.healthySamples,
    failedSamples: value.failedSamples,
    identityMismatches: value.identityMismatches,
    longestConsecutiveFailures: value.longestFailures,
    endingConsecutiveHealthy: value.endingHealthy,
    processExits: value.processExits,
    routingRevisionMismatches: value.routingRevisionMismatches,
    reasons: Object.freeze([...value.reasons].sort())
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function matchingIdentity(actual: ProcessIdentity, expected: ProcessIdentity | undefined): boolean {
  return expected !== undefined && sameTelemetryProcessIdentity(actual, expected);
}

function expectedRoute(bucket: number, basisPoints: number): RequestArm {
  if (bucket < 0 || bucket >= 10_000) throw new TypeError(`invalid routing bucket ${bucket}`);
  return bucket < basisPoints ? "candidate" : "stable";
}

function sourceGaps(
  events: readonly AcceptedTelemetryEvent[],
  binding: TelemetryWindowBinding,
  closePayload: Record<string, unknown>
): readonly Readonly<{ sourceKey: string; expected: readonly number[]; actual: readonly number[] }>[] {
  const closeCursors = object(closePayload.sourceCursorsAtClose, "sourceCursorsAtClose");
  const gaps: Array<Readonly<{ sourceKey: string; expected: readonly number[]; actual: readonly number[] }>> = [];
  for (const sourceKey of Object.keys(closeCursors).sort()) {
    const start = binding.sourceCursorsAtOpen[sourceKey] ?? 0;
    const end = integer(closeCursors[sourceKey], `${sourceKey} close cursor`);
    const actual = events
      .filter((event) => telemetrySourceBaseKey(event.source) === sourceKey)
      .map((event) => event.source.sourceSequence)
      .filter((sequence) => sequence > start && sequence <= end)
      .sort((left, right) => left - right);
    const expected = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index + 1);
    if (!same(actual, expected)) gaps.push(Object.freeze({ sourceKey, expected, actual }));
  }
  return Object.freeze(gaps);
}

function parseWindowBinding(openEvent: AcceptedTelemetryEventOf<"telemetry_window_opened">): TelemetryWindowBinding {
  const binding = openEvent.payload.binding;
  if (binding.windowId !== openEvent.windowId) throw new TypeError("window binding ID mismatch");
  const { bindingDigest: _digest, ...withoutDigest } = binding;
  if (canonicalSha256(withoutDigest) !== binding.bindingDigest || openEvent.payload.bindingDigest !== binding.bindingDigest) {
    throw new TypeError(`window binding digest mismatch for ${binding.windowId}`);
  }
  return structuredClone(binding);
}

function eventsOfType<K extends TelemetryEventType>(
  events: readonly AcceptedTelemetryEvent[],
  eventType: K
): readonly AcceptedTelemetryEventOf<K>[] {
  return events.filter((event): event is AcceptedTelemetryEventOf<K> => event.eventType === eventType);
}

function stale(binding: TelemetryWindowBinding, options: ReduceWindowOptions): boolean {
  return (options.activeTopologyEpoch !== undefined && options.activeTopologyEpoch !== binding.topologyEpoch)
    || (options.activeRoutingRevisionId !== undefined && options.activeRoutingRevisionId !== binding.routingRevisionId)
    || (options.activeCandidateReleaseId !== undefined && options.activeCandidateReleaseId !== binding.candidateReleaseId)
    || (options.activePolicyId !== undefined && options.activePolicyId !== binding.policyId);
}


interface EventReductionContext {
  readonly binding: TelemetryWindowBinding;
  readonly reasons: Set<string>;
  readonly arms: Record<RequestArm, ArmAccumulator>;
  readonly requests: Map<string, RequestAccumulator>;
  readonly health: Map<ComponentName, HealthAccumulator>;
  processExitObserved: boolean;
  responseIdentityMismatchObserved: boolean;
}

function requestProtocolError(context: EventReductionContext, reason: string, armValue?: RequestArm): void {
  context.reasons.add(`request_protocol:${reason}`);
  if (armValue !== undefined) context.arms[armValue].protocolFaults += 1;
}

function reduceRequestStarted(
  event: AcceptedTelemetryEventOf<"request_started">,
  context: EventReductionContext
): void {
  const payload = event.payload;
  if (context.requests.has(payload.requestId)) {
    requestProtocolError(context, "duplicate_start", payload.selectedArm);
    return;
  }
  if (context.binding.phase !== "staging" && expectedRoute(payload.bucket, context.binding.candidateBasisPoints) !== payload.selectedArm) {
    requestProtocolError(context, "route_attribution_mismatch", payload.selectedArm);
    return;
  }
  if (!matchingIdentity(payload.selectedComponent, context.binding.components[payload.selectedArm])) {
    requestProtocolError(context, "start_component_identity_mismatch", payload.selectedArm);
    return;
  }
  context.requests.set(payload.requestId, {
    requestId: payload.requestId,
    userId: payload.userId,
    arm: payload.selectedArm,
    attempts: 0,
    finished: false
  });
  const metrics = context.arms[payload.selectedArm];
  metrics.assigned += 1;
  metrics.dispatched += 1;
  metrics.usersAssigned.add(payload.userId);
}

function reduceRequestAttempt(
  event: AcceptedTelemetryEventOf<"request_attempt_finished">,
  context: EventReductionContext
): void {
  const payload = event.payload;
  const request = context.requests.get(payload.requestId);
  if (request === undefined) {
    requestProtocolError(context, "attempt_without_start", payload.selectedArm);
    return;
  }
  if (request.finished) {
    requestProtocolError(context, "attempt_after_completion", request.arm);
    return;
  }
  if (payload.selectedArm !== request.arm) {
    requestProtocolError(context, "attempt_changed_arm", request.arm);
    return;
  }
  if (payload.attemptOrdinal !== request.attempts + 1) {
    requestProtocolError(context, "noncontiguous_attempt", request.arm);
    return;
  }
  if (!matchingIdentity(payload.selectedComponent, context.binding.components[request.arm])) {
    requestProtocolError(context, "attempt_component_identity_mismatch", request.arm);
    return;
  }
  request.attempts += 1;
  const metrics = context.arms[request.arm];
  metrics.attempts += 1;
  metrics.attemptOutcomes[payload.outcome] = (metrics.attemptOutcomes[payload.outcome] ?? 0) + 1;
  if (payload.outcome !== "success") metrics.nonSuccessAttempts += 1;
  if (payload.outcome === "identity_mismatch" || (payload.outcome === "success" && !payload.responseIdentityVerified)) {
    context.responseIdentityMismatchObserved = true;
    requestProtocolError(context, "response_identity_mismatch", request.arm);
  }
}

function reduceRequestFinished(
  event: AcceptedTelemetryEventOf<"request_finished">,
  context: EventReductionContext
): void {
  const payload = event.payload;
  const request = context.requests.get(payload.requestId);
  if (request === undefined) {
    requestProtocolError(context, "finish_without_start", payload.selectedArm);
    return;
  }
  if (request.finished) {
    requestProtocolError(context, "duplicate_terminal", request.arm);
    return;
  }
  if (payload.selectedArm !== request.arm) {
    requestProtocolError(context, "finish_changed_arm", request.arm);
    return;
  }
  if (payload.attemptCount !== request.attempts) {
    requestProtocolError(context, "finish_attempt_count_mismatch", request.arm);
    return;
  }
  if (!matchingIdentity(payload.selectedComponent, context.binding.components[request.arm])) {
    requestProtocolError(context, "finish_component_identity_mismatch", request.arm);
    return;
  }
  request.finished = true;
  const metrics = context.arms[request.arm];
  metrics.finished += 1;
  metrics.usersFinished.add(request.userId);
  metrics.durations.push(payload.durationMs);
  if (payload.finalOutcome === "success") {
    metrics.successes += 1;
    if (payload.responseIdentityVerified) metrics.exactReleaseResponses += 1;
    else {
      context.responseIdentityMismatchObserved = true;
      requestProtocolError(context, "terminal_response_identity_mismatch", request.arm);
    }
  } else {
    metrics.finalFailures += 1;
  }
}

function reduceProtocolFault(
  event: AcceptedTelemetryEventOf<"protocol_fault">,
  context: EventReductionContext
): void {
  if (event.payload.requestId !== undefined) {
    const request = context.requests.get(event.payload.requestId);
    if (request?.finished === true) {
      requestProtocolError(context, "event_after_completion", request.arm);
      return;
    }
  }
  requestProtocolError(context, event.payload.condition, event.payload.selectedArm);
}

function reduceHealthSample(
  event: AcceptedTelemetryEventOf<"process_health_sampled">,
  context: EventReductionContext
): void {
  const reported = event.payload.component;
  const name = componentForProcessIdentity(reported);
  const accumulator = context.health.get(name) ?? newHealth(name);
  context.health.set(name, accumulator);
  accumulator.samples += 1;
  if (!matchingIdentity(reported, context.binding.components[name])) {
    accumulator.identityMismatches += 1;
    accumulator.reasons.add("identity_mismatch");
  }
  if (event.payload.healthy) {
    accumulator.healthySamples += 1;
    accumulator.currentFailures = 0;
    accumulator.endingHealthy += 1;
  } else {
    accumulator.failedSamples += 1;
    accumulator.currentFailures += 1;
    accumulator.longestFailures = Math.max(accumulator.longestFailures, accumulator.currentFailures);
    accumulator.endingHealthy = 0;
    accumulator.reasons.add(event.payload.reason ?? "probe_failed");
  }
  if (name === "router" && event.payload.reportedRoutingRevisionId !== context.binding.routingRevisionId) {
    accumulator.routingRevisionMismatches += 1;
    accumulator.reasons.add("routing_revision_mismatch");
  }
}

function reduceProcessExit(
  event: AcceptedTelemetryEventOf<"process_exited">,
  context: EventReductionContext
): void {
  const reported = event.payload.component;
  const name = componentForProcessIdentity(reported);
  const accumulator = context.health.get(name) ?? newHealth(name);
  context.health.set(name, accumulator);
  accumulator.processExits += 1;
  accumulator.reasons.add("process_exited");
  context.processExitObserved = true;
}

function reduceEvent(event: AcceptedTelemetryEvent, context: EventReductionContext): void {
  switch (event.eventType) {
    case "request_started": reduceRequestStarted(event, context); return;
    case "request_attempt_finished": reduceRequestAttempt(event, context); return;
    case "request_finished": reduceRequestFinished(event, context); return;
    case "protocol_fault": reduceProtocolFault(event, context); return;
    case "process_health_sampled": reduceHealthSample(event, context); return;
    case "process_exited": reduceProcessExit(event, context); return;
    case "routing_revision_applied":
    case "telemetry_window_opened":
    case "telemetry_window_closed": return;
  }
}

export function reduceTelemetryFrame(
  journal: AcceptedEventJournal,
  windowId: string,
  throughIngestSequence: number
): TelemetryWindowSummary {
  return reduceTelemetryWindow(journal, windowId, { throughIngestSequence });
}

export function reduceTelemetryWindow(
  journal: AcceptedEventJournal,
  windowId: string,
  options: ReduceWindowOptions = {}
): TelemetryWindowSummary {
  const all = journal.snapshot().filter((event) =>
    event.windowId === windowId
    && (options.throughIngestSequence === undefined || event.ingestSequence <= options.throughIngestSequence));
  if (all.length === 0) throw new TypeError(`unknown telemetry window ${windowId}`);
  const revisions = eventsOfType(all, "routing_revision_applied");
  const opens = eventsOfType(all, "telemetry_window_opened");
  const closes = eventsOfType(all, "telemetry_window_closed");
  if (revisions.length !== 1) throw new TypeError(`${windowId} requires one applied Routing Revision`);
  if (opens.length !== 1) throw new TypeError(`${windowId} requires one open event`);
  if (closes.length > 1) throw new TypeError(`${windowId} has duplicate close events`);
  const revision = revisions[0];
  const open = opens[0];
  if (revision === undefined || open === undefined) throw new TypeError(`${windowId} missing required events`);
  const binding = parseWindowBinding(open);
  const reasons = new Set<string>();

  if (revision.payload.observedFingerprint !== binding.routingConfigFingerprint) reasons.add("router_fingerprint_mismatch");
  if (canonicalSha256(revision.payload.revisionManifest) !== binding.routingConfigFingerprint) reasons.add("routing_manifest_mismatch");
  for (const event of all) {
    if (!same(event.binding, {
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
    })) reasons.add("event_binding_mismatch");
  }

  const arms: Record<RequestArm, ArmAccumulator> = { stable: newArm(), candidate: newArm() };
  const requests = new Map<string, RequestAccumulator>();
  const healthAcc = new Map<ComponentName, HealthAccumulator>();
  for (const name of Object.keys(binding.components) as ComponentName[]) healthAcc.set(name, newHealth(name));
  const reduction: EventReductionContext = {
    binding,
    reasons,
    arms,
    requests,
    health: healthAcc,
    processExitObserved: false,
    responseIdentityMismatchObserved: false
  };
  for (const event of all) reduceEvent(event, reduction);
  const processExitObserved = reduction.processExitObserved;
  const responseIdentityMismatchObserved = reduction.responseIdentityMismatchObserved;

  const close = closes[0];
  const closePayload = close?.payload ?? null;
  const elapsedMs = close === undefined ? Math.max(0, (all.at(-1)?.monotonicMs ?? open.monotonicMs) - open.monotonicMs) : close.monotonicMs - open.monotonicMs;
  const expectedHealthSamples = Math.max(
    ROLLOUT_POLICY_V1.health.minimumSamplesPerRequiredComponent,
    Math.floor(elapsedMs / ROLLOUT_POLICY_V1.health.probeIntervalMs) + 1
  );
  const health: Partial<Record<ComponentName, ComponentHealthSummary>> = {};
  for (const [name, accumulator] of healthAcc) health[name] = finishHealth(accumulator, expectedHealthSamples);

  const gaps = closePayload === null ? [] : sourceGaps(all, binding, closePayload);
  if (gaps.length > 0) reasons.add("source_sequence_gap");
  if (closePayload !== null && closePayload.inFlightRequests !== 0) reasons.add("requests_in_flight");
  for (const required of binding.requiredComponents) {
    const requiredHealth = health[required];
    if (requiredHealth === undefined || requiredHealth.samples < expectedHealthSamples) reasons.add(`missing_health:${required}`);
  }
  if (processExitObserved) reasons.add("required_process_exited");

  let completeness: WindowCompleteness;
  const hasProtocolConflict = [...reasons].some((reason) => reason.startsWith("request_protocol:"));
  if (journal.conflictsForWindow(windowId).length > 0 || reasons.has("event_binding_mismatch") || reasons.has("routing_manifest_mismatch") || reasons.has("router_fingerprint_mismatch") || hasProtocolConflict) {
    completeness = "invalid_conflict";
  } else if (stale(binding, options)) {
    completeness = "stale";
  } else if (gaps.length > 0 || [...reasons].some((reason) => reason.startsWith("missing_health:"))) {
    completeness = "incomplete_gap";
  } else if (close === undefined || processExitObserved || reasons.has("requests_in_flight")) {
    completeness = "incomplete_interrupted";
  } else {
    completeness = "complete";
  }

  const metrics = Object.freeze({ stable: finishArm(arms.stable), candidate: finishArm(arms.candidate) });
  const acceptedEventStart = Math.min(...all.map((event) => event.ingestSequence));
  const acceptedEventEnd = Math.max(...all.map((event) => event.ingestSequence));
  const provisional = {
    schemaVersion: TELEMETRY_SUMMARY_SCHEMA_VERSION,
    factoryRunId: binding.factoryRunId,
    windowId,
    binding,
    acceptedEventStart,
    acceptedEventEnd,
    acceptedEventDigest: canonicalSha256(all),
    elapsedMs,
    completeness,
    completenessReasons: Object.freeze([...reasons].sort()),
    sourceGaps: gaps,
    metrics,
    health: Object.freeze(health),
    processExitObserved,
    responseIdentityMismatchObserved
  } as const;
  return Object.freeze({ ...provisional, windowDigest: canonicalSha256(provisional) });
}

function armSufficiency(metrics: ArmMetrics, floor: ArmEvidenceFloor | null): ArmSufficiency {
  if (floor === null) {
    return Object.freeze({
      required: false,
      finishedRequestsSatisfied: true,
      uniqueFinishedUsersSatisfied: true,
      actualFinishedRequests: metrics.logicalRequestsFinished,
      actualUniqueFinishedUsers: metrics.uniqueFinishedUsers,
      minimumFinishedRequests: 0,
      minimumUniqueFinishedUsers: 0
    });
  }
  return Object.freeze({
    required: true,
    finishedRequestsSatisfied: metrics.logicalRequestsFinished >= floor.minimumFinishedRequests,
    uniqueFinishedUsersSatisfied: metrics.uniqueFinishedUsers >= floor.minimumUniqueFinishedUsers,
    actualFinishedRequests: metrics.logicalRequestsFinished,
    actualUniqueFinishedUsers: metrics.uniqueFinishedUsers,
    minimumFinishedRequests: floor.minimumFinishedRequests,
    minimumUniqueFinishedUsers: floor.minimumUniqueFinishedUsers
  });
}

export function evaluateSufficiency(summary: TelemetryWindowSummary): SufficiencyAssessment {
  const policy = gatePolicy(summary.binding.gate);
  const stable = armSufficiency(summary.metrics.stable, policy.stable);
  const candidate = armSufficiency(summary.metrics.candidate, policy.candidate);
  const durationSatisfied = summary.elapsedMs >= policy.minimumDurationMs;
  let state: SufficiencyAssessment["state"];
  if (summary.completeness !== "complete") state = "not_evaluated";
  else if (!durationSatisfied) state = "complete_insufficient_duration";
  else if (!stable.finishedRequestsSatisfied || !stable.uniqueFinishedUsersSatisfied || !candidate.finishedRequestsSatisfied || !candidate.uniqueFinishedUsersSatisfied) state = "complete_insufficient_samples";
  else state = "complete_sufficient";
  return Object.freeze({
    state,
    durationSatisfied,
    actualDurationMs: summary.elapsedMs,
    minimumDurationMs: policy.minimumDurationMs,
    stable,
    candidate
  });
}
