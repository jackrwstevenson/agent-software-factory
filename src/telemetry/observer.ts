import { canonicalSha256 } from "../protocol/canonical-json.js";
import { OBSERVER_RESULT_SCHEMA_VERSION } from "./contracts.js";
import type { TelemetryWindowSummary } from "./window-reducer.js";
import {
  conditionCanClear,
  type ObservedCondition,
  type TelemetryAssessment
} from "./assessment.js";
import {
  IncidentStore,
  type IncidentRecord,
  type IncidentSummary,
  type IncidentTransition
} from "./incidents.js";

export class WorkerUnavailable extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailable";
  }
}

export interface ObserverInput {
  readonly schemaVersion: "observer-input/v1";
  readonly observerSessionId: string;
  readonly sampleSequence: number;
  readonly previousAcceptedEventCursor: number;
  readonly acceptedEventCursor: number;
  readonly factoryRunId: string;
  readonly candidateReleaseId: string;
  readonly stableReleaseId: string;
  readonly topologyEpoch: number;
  readonly routingRevisionId: string;
  readonly routingConfigFingerprint: string;
  readonly policyId: string;
  readonly phase: TelemetryWindowSummary["binding"]["phase"];
  readonly gate: TelemetryWindowSummary["binding"]["gate"];
  readonly windowId: string;
  readonly windowDigest: string;
  readonly assessment: TelemetryAssessment;
  readonly knownIncidents: readonly IncidentRecord[];
  readonly knownIncidentDigest: string;
  readonly inputDigest: string;
}

export interface ObserverResult {
  readonly schemaVersion: typeof OBSERVER_RESULT_SCHEMA_VERSION;
  readonly role: "observer";
  readonly invocationId: string;
  readonly observerSessionId: string;
  readonly sampleSequence: number;
  readonly acceptedEventCursor: number;
  readonly factoryRunId: string;
  readonly candidateReleaseId: string;
  readonly routingRevisionId: string;
  readonly windowId: string;
  readonly windowDigest: string;
  readonly inputDigest: string;
  readonly evidenceState: string;
  readonly assessmentDigest: string;
  readonly facts: Readonly<{
    completeness: TelemetryAssessment["completeness"];
    sufficiency: TelemetryAssessment["sufficiency"]["state"];
    signals: TelemetryAssessment["signals"];
  }>;
  readonly incidentTransitions: readonly IncidentTransition[];
  readonly semanticResultDigest: string;
  readonly resultDigest: string;
}

export interface AcceptedObserverRecord {
  readonly kind: "accepted_observer_result";
  readonly observerSessionId: string;
  readonly sampleSequence: number;
  readonly acceptedEventCursor: number;
  readonly factoryRunId: string;
  readonly candidateReleaseId: string;
  readonly routingRevisionId: string;
  readonly windowId: string;
  readonly windowDigest: string;
  readonly inputDigest: string;
  readonly evidenceState: string;
  readonly assessmentDigest: string;
  readonly semanticResultDigest: string;
  readonly appliedTransitions: readonly Readonly<Record<string, unknown>>[];
  readonly openIncidents: readonly IncidentSummary[];
  readonly incidentStoreDigest: string;
  readonly acceptedRecordDigest: string;
  readonly duplicate: boolean;
}

export interface ObserverSessionSnapshot {
  readonly schemaVersion: "observer-session/v1";
  readonly sessionId: string;
  readonly nextSampleSequence: number;
  readonly acceptedEventCursor: number;
  readonly acceptedRecords: readonly AcceptedObserverRecord[];
  readonly sessionDigest: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
}

function immutableClone<T>(value: T): T {
  const copied = clone(value);
  deepFreeze(copied);
  return copied;
}

export class ObserverSession {
  #nextSampleSequence = 1;
  #acceptedEventCursor = 0;
  readonly #acceptedByInputDigest = new Map<string, AcceptedObserverRecord>();

  public constructor(readonly sessionId = "observer-session-1") {}

  public get nextSampleSequence(): number { return this.#nextSampleSequence; }
  public get acceptedEventCursor(): number { return this.#acceptedEventCursor; }

  public accepted(inputDigest: string): AcceptedObserverRecord | null {
    return this.#acceptedByInputDigest.get(inputDigest) ?? null;
  }

  public advance(inputDigest: string, accepted: AcceptedObserverRecord): void {
    if (accepted.sampleSequence !== this.#nextSampleSequence) throw new Error("Observer session advancement sequence mismatch");
    if (accepted.acceptedEventCursor < this.#acceptedEventCursor) throw new Error("Observer session advancement cursor regressed");
    if (this.#acceptedByInputDigest.has(inputDigest)) throw new Error("Observer session input already accepted");
    this.#acceptedByInputDigest.set(inputDigest, accepted);
    this.#nextSampleSequence += 1;
    this.#acceptedEventCursor = accepted.acceptedEventCursor;
  }

  public snapshot(): ObserverSessionSnapshot {
    const core = {
      schemaVersion: "observer-session/v1" as const,
      sessionId: this.sessionId,
      nextSampleSequence: this.#nextSampleSequence,
      acceptedEventCursor: this.#acceptedEventCursor,
      acceptedRecords: immutableClone([...this.#acceptedByInputDigest.values()])
    };
    return immutableClone({ ...core, sessionDigest: canonicalSha256(core) });
  }

  public static replay(snapshot: ObserverSessionSnapshot): ObserverSession {
    const { sessionDigest: _digest, ...core } = snapshot;
    if (canonicalSha256(core) !== snapshot.sessionDigest) throw new Error("Observer session digest mismatch");
    const session = new ObserverSession(snapshot.sessionId);
    for (const accepted of snapshot.acceptedRecords) {
      session.#acceptedByInputDigest.set(accepted.inputDigest, clone(accepted));
    }
    session.#nextSampleSequence = snapshot.nextSampleSequence;
    session.#acceptedEventCursor = snapshot.acceptedEventCursor;
    return session;
  }
}

export function buildObserverInput(
  summary: TelemetryWindowSummary,
  assessment: TelemetryAssessment,
  incidents: IncidentStore,
  session: ObserverSession
): ObserverInput {
  const core = {
    schemaVersion: "observer-input/v1" as const,
    observerSessionId: session.sessionId,
    sampleSequence: session.nextSampleSequence,
    previousAcceptedEventCursor: session.acceptedEventCursor,
    acceptedEventCursor: summary.acceptedEventEnd,
    factoryRunId: summary.factoryRunId,
    candidateReleaseId: summary.binding.candidateReleaseId,
    stableReleaseId: summary.binding.stableReleaseId,
    topologyEpoch: summary.binding.topologyEpoch,
    routingRevisionId: summary.binding.routingRevisionId,
    routingConfigFingerprint: summary.binding.routingConfigFingerprint,
    policyId: summary.binding.policyId,
    phase: summary.binding.phase,
    gate: summary.binding.gate,
    windowId: summary.windowId,
    windowDigest: summary.windowDigest,
    assessment,
    knownIncidents: clone(incidents.records),
    knownIncidentDigest: incidents.digest()
  };
  return Object.freeze({ ...core, inputDigest: canonicalSha256(core) });
}

function currentByKey(assessment: TelemetryAssessment): Map<string, ObservedCondition> {
  return new Map(assessment.conditions.map((condition) => [condition.deduplicationKey, condition]));
}

function latestOpen(records: readonly IncidentRecord[]): readonly IncidentRecord[] {
  return records.filter((record) => record.state === "open").sort((left, right) => left.incidentId.localeCompare(right.incidentId));
}

export function invokeObserver(
  input: ObserverInput,
  invocationId = "observer-invocation-1",
  options: Readonly<{ technicalFailure?: boolean }> = {}
): ObserverResult {
  if (options.technicalFailure === true) throw new WorkerUnavailable("Observer process unavailable");
  const current = currentByKey(input.assessment);
  const transitions: IncidentTransition[] = [];

  for (const condition of input.assessment.conditions) {
    const existing = input.knownIncidents.find((record) =>
      record.deduplicationKey === condition.deduplicationKey && record.state === "open");
    if (existing === undefined) {
      transitions.push(Object.freeze({ kind: "open", condition }));
    } else {
      transitions.push(Object.freeze({
        kind: "update",
        deduplicationKey: condition.deduplicationKey,
        conditionId: condition.conditionId,
        severity: condition.severity,
        evidence: condition.evidence,
        conditionPresent: true,
        nextCleanStreak: 0
      }));
    }
  }

  for (const record of latestOpen(input.knownIncidents)) {
    if (current.has(record.deduplicationKey)) continue;
    if (!conditionCanClear(record.conditionId, input.assessment)) continue;
    const nextCleanStreak = record.cleanStreak + 1;
    const required = record.cleanWindowsToResolve;
    if (nextCleanStreak >= required) {
      transitions.push(Object.freeze({
        kind: "resolve",
        deduplicationKey: record.deduplicationKey,
        conditionId: record.conditionId,
        evidence: Object.freeze({ cleanWindowId: input.windowId, cleanWindowsObserved: nextCleanStreak }),
        nextCleanStreak,
        resolutionKind: record.conditionId === "telemetry.monitoring_gap" ? "cursor_reconciled" : "condition_cleared"
      }));
    } else {
      transitions.push(Object.freeze({
        kind: "update",
        deduplicationKey: record.deduplicationKey,
        conditionId: record.conditionId,
        severity: record.severity,
        evidence: Object.freeze({ cleanWindowId: input.windowId, cleanWindowsObserved: nextCleanStreak }),
        conditionPresent: false,
        nextCleanStreak
      }));
    }
  }

  const semanticCore = {
    schemaVersion: OBSERVER_RESULT_SCHEMA_VERSION,
    role: "observer" as const,
    observerSessionId: input.observerSessionId,
    sampleSequence: input.sampleSequence,
    acceptedEventCursor: input.acceptedEventCursor,
    factoryRunId: input.factoryRunId,
    candidateReleaseId: input.candidateReleaseId,
    routingRevisionId: input.routingRevisionId,
    windowId: input.windowId,
    windowDigest: input.windowDigest,
    inputDigest: input.inputDigest,
    evidenceState: input.assessment.evidenceState,
    assessmentDigest: input.assessment.assessmentDigest,
    facts: Object.freeze({
      completeness: input.assessment.completeness,
      sufficiency: input.assessment.sufficiency.state,
      signals: input.assessment.signals
    }),
    incidentTransitions: Object.freeze(transitions)
  };
  const semanticResultDigest = canonicalSha256(semanticCore);
  const core = { ...semanticCore, invocationId, semanticResultDigest };
  return Object.freeze({ ...core, resultDigest: canonicalSha256(core) });
}

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "action",
  "proposal",
  "routingCommand",
  "lifecycleState",
  "lifecycleTransition",
  "candidateBasisPointsCommand"
]);

function forbiddenAuthority(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = forbiddenAuthority(child, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_AUTHORITY_KEYS.has(key)) return `${path}.${key}`;
      const found = forbiddenAuthority(child, `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

export function acceptObserverResult(
  input: ObserverInput,
  result: ObserverResult,
  incidents: IncidentStore,
  session: ObserverSession
): AcceptedObserverRecord {
  const prior = session.accepted(input.inputDigest);
  if (prior !== null) return Object.freeze({ ...prior, duplicate: true });
  const forbidden = forbiddenAuthority(result);
  if (forbidden !== null) throw new Error(`Observer result contains forbidden authority field ${forbidden}`);
  if (result.observerSessionId !== input.observerSessionId) throw new Error("Observer session mismatch");
  if (result.sampleSequence !== input.sampleSequence || input.sampleSequence !== session.nextSampleSequence) {
    throw new Error("stale Observer sample sequence");
  }
  if (result.inputDigest !== input.inputDigest) throw new Error("Observer input digest mismatch");
  if (result.windowDigest !== input.windowDigest || result.windowId !== input.windowId) throw new Error("Observer window mismatch");
  if (result.assessmentDigest !== input.assessment.assessmentDigest) throw new Error("Observer assessment digest mismatch");
  if (result.acceptedEventCursor !== input.acceptedEventCursor) throw new Error("Observer cursor mismatch");
  if (input.previousAcceptedEventCursor !== session.acceptedEventCursor) throw new Error("Observer previous cursor mismatch");
  if (input.acceptedEventCursor < input.previousAcceptedEventCursor) throw new Error("Observer cursor regressed");
  if (incidents.digest() !== input.knownIncidentDigest) throw new Error("Observer incident input is stale");
  const expected = invokeObserver(input, "acceptance-validation");
  if (expected.semanticResultDigest !== result.semanticResultDigest) throw new Error("Observer semantic result mismatch");

  const appliedTransitions = result.incidentTransitions.map((transition) =>
    incidents.applyTransition(transition, result.sampleSequence, result.windowId));
  const acceptedCore = {
    kind: "accepted_observer_result" as const,
    observerSessionId: result.observerSessionId,
    sampleSequence: result.sampleSequence,
    acceptedEventCursor: result.acceptedEventCursor,
    factoryRunId: result.factoryRunId,
    candidateReleaseId: result.candidateReleaseId,
    routingRevisionId: result.routingRevisionId,
    windowId: result.windowId,
    windowDigest: result.windowDigest,
    inputDigest: result.inputDigest,
    evidenceState: result.evidenceState,
    assessmentDigest: result.assessmentDigest,
    semanticResultDigest: result.semanticResultDigest,
    appliedTransitions: Object.freeze(appliedTransitions),
    openIncidents: incidents.openSummaries(),
    incidentStoreDigest: incidents.digest()
  };
  const accepted: AcceptedObserverRecord = Object.freeze({
    ...acceptedCore,
    acceptedRecordDigest: canonicalSha256(acceptedCore),
    duplicate: false
  });
  session.advance(input.inputDigest, accepted);
  return accepted;
}

export function observerUnavailableFact(input: ObserverInput, attemptsExhausted: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "observer-unavailable/v1",
    kind: "orchestrator_observer_unavailable",
    authority: "orchestrator",
    inputDigest: input.inputDigest,
    attemptsExhausted,
    allowedEffect: "hold_or_pause_only"
  });
}
