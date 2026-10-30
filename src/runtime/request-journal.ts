import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../protocol/canonical-json.js";
import type { RoutingDecision } from "./routing.js";
import {
  assertRoutingRevisionTransition,
  type RoutingRevision
} from "./routing-revision.js";

export type RequestTarget = "stable" | "candidate";
export type AttemptOutcome = "success" | "error" | "unavailable";
export type ProtocolFaultKind = "release_identity_mismatch" | "process_identity_mismatch" | "invalid_response";

export const RUNTIME_EVENT_TYPES = [
  "routing_change_pending",
  "routing_change_applied",
  "traffic_window_opened",
  "traffic_window_closed",
  "request_started",
  "attempt_started",
  "protocol_fault",
  "attempt_finished",
  "request_finished"
] as const;
export type RuntimeEventType = typeof RUNTIME_EVENT_TYPES[number];
const EVENT_TYPES = new Set<string>(RUNTIME_EVENT_TYPES);

export interface RequestBinding {
  readonly routingRevision: number;
  readonly routingFullFingerprint: string;
  readonly workloadVersion: "synthetic-users-v1";
  readonly workloadUsersDigest: string;
}

interface RuntimeEventBase {
  readonly sequence: number;
  readonly type: RuntimeEventType;
  readonly factoryRunId: string;
  readonly at: string;
}

interface RoutingEventBase extends RuntimeEventBase {
  readonly revision: RoutingRevision;
}

export interface RoutingChangePendingEvent extends RoutingEventBase {
  readonly type: "routing_change_pending";
}

export interface RoutingChangeAppliedEvent extends RoutingEventBase {
  readonly type: "routing_change_applied";
}

export interface TrafficWindowOpenedEvent extends RoutingEventBase {
  readonly type: "traffic_window_opened";
  readonly windowId: string;
}

export interface TrafficWindowClosedEvent extends RoutingEventBase {
  readonly type: "traffic_window_closed";
  readonly windowId: string;
  readonly reason: "routing_change" | "shutdown" | "interrupted";
}

interface RequestEventBase extends RuntimeEventBase, RequestBinding {
  readonly requestId: string;
  readonly target: RequestTarget;
  readonly releaseId: string;
  readonly processAttempt: number;
}

export interface RequestStartedEvent extends RequestEventBase {
  readonly type: "request_started";
  readonly userId: string;
  readonly bucket: number;
  readonly candidateBasisPoints: number;
  readonly configFingerprint: string;
}

export interface AttemptStartedEvent extends RequestEventBase {
  readonly type: "attempt_started";
  readonly attempt: number;
}

export interface ProtocolFaultEvent extends RequestEventBase {
  readonly type: "protocol_fault";
  readonly attempt: number;
  readonly faultKind: ProtocolFaultKind;
  readonly expectedReleaseId: string;
  readonly observedReleaseId: string | null;
  readonly expectedProcessAttempt: number;
  readonly observedProcessAttempt: number | null;
  readonly detail: string;
}

export interface AttemptFinishedEvent extends RequestEventBase {
  readonly type: "attempt_finished";
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  readonly statusCode: number | null;
  readonly latencyMs: number;
}

export interface RequestFinishedEvent extends RequestEventBase {
  readonly type: "request_finished";
  readonly attempts: number;
  readonly outcome: "success" | "failed";
}

export type RuntimeEvent =
  | RoutingChangePendingEvent
  | RoutingChangeAppliedEvent
  | TrafficWindowOpenedEvent
  | TrafficWindowClosedEvent
  | RequestStartedEvent
  | AttemptStartedEvent
  | ProtocolFaultEvent
  | AttemptFinishedEvent
  | RequestFinishedEvent;
export type RequestEvent = Extract<RuntimeEvent, { readonly requestId: string }>;
export type NewRuntimeEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "sequence"> : never
  : never;

export interface RequestAccountingSummary {
  readonly logicalRequests: Record<RequestTarget, number>;
  readonly uniqueExposedUsers: Record<RequestTarget, number>;
  readonly attempts: Record<RequestTarget, number>;
  readonly retries: Record<RequestTarget, number>;
  readonly protocolFaults: Record<RequestTarget, number>;
  readonly attemptOutcomes: Record<RequestTarget, Record<AttemptOutcome, number>>;
  readonly finalOutcomes: Record<RequestTarget, Record<"success" | "failed", number>>;
  readonly maxObservedLatencyMs: Record<RequestTarget, number>;
}

export interface ReplayedTrafficWindow {
  readonly windowId: string;
  readonly revision: RoutingRevision;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closeReason: TrafficWindowClosedEvent["reason"] | null;
}

export interface RuntimeReplayState {
  readonly desiredRouting: RoutingRevision | null;
  readonly appliedRouting: RoutingRevision | null;
  readonly windows: readonly ReplayedTrafficWindow[];
  readonly accounting: RequestAccountingSummary;
}

interface RequestReplay {
  readonly factoryRunId: string;
  readonly target: RequestTarget;
  readonly releaseId: string;
  readonly processAttempt: number;
  readonly routingRevision: number;
  readonly routingFullFingerprint: string;
  readonly workloadVersion: string;
  readonly workloadUsersDigest: string;
  attempts: number;
  activeAttempt: number | null;
  activeAttemptFaulted: boolean;
  finished: boolean;
}

function stableEvent(event: RuntimeEvent): string {
  return canonicalJson(event);
}

function emptySummary(): RequestAccountingSummary {
  return {
    logicalRequests: { stable: 0, candidate: 0 },
    uniqueExposedUsers: { stable: 0, candidate: 0 },
    attempts: { stable: 0, candidate: 0 },
    retries: { stable: 0, candidate: 0 },
    protocolFaults: { stable: 0, candidate: 0 },
    attemptOutcomes: {
      stable: { success: 0, error: 0, unavailable: 0 },
      candidate: { success: 0, error: 0, unavailable: 0 }
    },
    finalOutcomes: {
      stable: { success: 0, failed: 0 },
      candidate: { success: 0, failed: 0 }
    },
    maxObservedLatencyMs: { stable: 0, candidate: 0 }
  };
}

function assertKnownType(type: unknown): asserts type is RuntimeEventType {
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) throw new Error(`unknown runtime event type ${String(type)}`);
}

export class RuntimeEventJournal {
  readonly events: RuntimeEvent[] = [];

  constructor(events: readonly RuntimeEvent[] = []) {
    if (!Array.isArray(events)) throw new TypeError("runtime journal events must be an array");
    for (const event of events) this.replayEvent(event);
  }

  append(event: NewRuntimeEvent): RuntimeEvent {
    assertKnownType(event.type);
    const persisted = Object.freeze({ ...event, sequence: this.events.length + 1 }) as RuntimeEvent;
    this.events.push(persisted);
    return persisted;
  }

  replayEvent(event: RuntimeEvent): void {
    if (event === null || typeof event !== "object" || Array.isArray(event)) throw new TypeError("runtime journal event must be an object");
    assertKnownType((event as RuntimeEvent).type);
    if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error("event sequence must be a positive integer");
    const expected = this.events.length + 1;
    if (event.sequence < expected) {
      const existing = this.events[event.sequence - 1];
      if (!existing || stableEvent(existing) !== stableEvent(event)) throw new Error(`conflicting duplicate event sequence ${event.sequence}`);
      return;
    }
    if (event.sequence !== expected) throw new Error(`global event sequence gap at ${expected}`);
    this.events.push(Object.freeze({ ...event }));
  }

  snapshot(): RuntimeEvent[] {
    return JSON.parse(JSON.stringify(this.events)) as RuntimeEvent[];
  }

  summary(): RequestAccountingSummary {
    return this.replayState().accounting;
  }

  replayState(): RuntimeReplayState {
    let desiredRouting: RoutingRevision | null = null;
    let appliedRouting: RoutingRevision | null = null;
    const windows = new Map<string, ReplayedTrafficWindow>();
    let openWindowId: string | null = null;
    const requests = new Map<string, RequestReplay>();
    const users: Record<RequestTarget, Set<string>> = { stable: new Set(), candidate: new Set() };
    const accounting = emptySummary();

    for (const [index, event] of this.events.entries()) {
      if (event.sequence !== index + 1) throw new Error(`global event sequence gap at ${index + 1}`);
      assertKnownType(event.type);
      switch (event.type) {
        case "routing_change_pending":
          assertRoutingRevisionTransition(appliedRouting, event.revision);
          desiredRouting = event.revision;
          break;
        case "routing_change_applied":
          if (!desiredRouting || desiredRouting.fullFingerprint !== event.revision.fullFingerprint) {
            throw new Error(`routing_change_applied lacks matching pending revision ${event.revision.revision}`);
          }
          assertRoutingRevisionTransition(appliedRouting, event.revision);
          appliedRouting = event.revision;
          desiredRouting = event.revision;
          break;
        case "traffic_window_opened":
          if (!appliedRouting || appliedRouting.fullFingerprint !== event.revision.fullFingerprint) {
            throw new Error(`traffic window ${event.windowId} does not bind the applied routing revision`);
          }
          if (openWindowId !== null) throw new Error(`traffic window ${openWindowId} is still open`);
          if (windows.has(event.windowId)) throw new Error(`duplicate traffic window ${event.windowId}`);
          windows.set(event.windowId, {
            windowId: event.windowId,
            revision: event.revision,
            openedAt: event.at,
            closedAt: null,
            closeReason: null
          });
          openWindowId = event.windowId;
          break;
        case "traffic_window_closed": {
          const window = windows.get(event.windowId);
          if (!window || openWindowId !== event.windowId) throw new Error(`traffic window ${event.windowId} is not open`);
          if (window.revision.fullFingerprint !== event.revision.fullFingerprint) throw new Error(`traffic window ${event.windowId} routing changed`);
          windows.set(event.windowId, { ...window, closedAt: event.at, closeReason: event.reason });
          openWindowId = null;
          break;
        }
        case "request_started":
          if (requests.has(event.requestId)) throw new Error(`duplicate request_started for ${event.requestId}`);
          if (appliedRouting && (
            event.routingRevision !== appliedRouting.revision
            || event.routingFullFingerprint !== appliedRouting.fullFingerprint
          )) throw new Error(`request ${event.requestId} does not bind applied routing`);
          requests.set(event.requestId, {
            factoryRunId: event.factoryRunId,
            target: event.target,
            releaseId: event.releaseId,
            processAttempt: event.processAttempt,
            routingRevision: event.routingRevision,
            routingFullFingerprint: event.routingFullFingerprint,
            workloadVersion: event.workloadVersion,
            workloadUsersDigest: event.workloadUsersDigest,
            attempts: 0,
            activeAttempt: null,
            activeAttemptFaulted: false,
            finished: false
          });
          accounting.logicalRequests[event.target] += 1;
          users[event.target].add(event.userId);
          break;
        case "attempt_started": {
          const request = requireRequest(requests, event);
          assertRequestBinding(request, event);
          if (request.finished) throw new Error(`event follows request_finished for ${event.requestId}`);
          if (request.activeAttempt !== null) throw new Error(`attempt ${request.activeAttempt} is still active for ${event.requestId}`);
          if (event.attempt !== request.attempts + 1) throw new Error(`attempt sequence gap for ${event.requestId}`);
          request.activeAttempt = event.attempt;
          request.activeAttemptFaulted = false;
          break;
        }
        case "protocol_fault": {
          const request = requireRequest(requests, event);
          assertRequestBinding(request, event);
          if (request.activeAttempt !== event.attempt) throw new Error(`protocol_fault lacks active attempt for ${event.requestId}`);
          request.activeAttemptFaulted = true;
          accounting.protocolFaults[event.target] += 1;
          break;
        }
        case "attempt_finished": {
          const request = requireRequest(requests, event);
          assertRequestBinding(request, event);
          if (request.activeAttempt !== event.attempt) throw new Error(`attempt_finished lacks attempt_started for ${event.requestId}`);
          if (request.activeAttemptFaulted && event.outcome !== "error") throw new Error(`protocol fault attempt must finish as error for ${event.requestId}`);
          if (!Number.isFinite(event.latencyMs) || event.latencyMs < 0) throw new Error("latencyMs must be nonnegative");
          request.attempts += 1;
          request.activeAttempt = null;
          request.activeAttemptFaulted = false;
          accounting.attempts[event.target] += 1;
          if (event.attempt > 1) accounting.retries[event.target] += 1;
          accounting.attemptOutcomes[event.target][event.outcome] += 1;
          accounting.maxObservedLatencyMs[event.target] = Math.max(accounting.maxObservedLatencyMs[event.target], event.latencyMs);
          break;
        }
        case "request_finished": {
          const request = requireRequest(requests, event);
          assertRequestBinding(request, event);
          if (request.activeAttempt !== null) throw new Error(`request_finished while attempt is active for ${event.requestId}`);
          if (request.attempts === 0) throw new Error(`request_finished without attempt for ${event.requestId}`);
          if (event.attempts !== request.attempts) throw new Error(`final attempt count mismatch for ${event.requestId}`);
          if (request.finished) throw new Error(`duplicate request_finished for ${event.requestId}`);
          request.finished = true;
          accounting.finalOutcomes[event.target][event.outcome] += 1;
          break;
        }
      }
    }

    for (const [requestId, request] of requests) {
      if (!request.finished) throw new Error(`unfinished request ${requestId}`);
    }
    accounting.uniqueExposedUsers.stable = users.stable.size;
    accounting.uniqueExposedUsers.candidate = users.candidate.size;
    return {
      desiredRouting,
      appliedRouting,
      windows: [...windows.values()],
      accounting
    };
  }
}

function requireRequest(requests: Map<string, RequestReplay>, event: RequestEvent): RequestReplay {
  const request = requests.get(event.requestId);
  if (!request) throw new Error(`${event.type} precedes request_started for ${event.requestId}`);
  return request;
}

function assertRequestBinding(request: RequestReplay, event: RequestEvent): void {
  if (event.factoryRunId !== request.factoryRunId) throw new Error(`Factory Run changed during ${event.requestId}`);
  if (event.target !== request.target) throw new Error(`target changed during ${event.requestId}`);
  if (event.releaseId !== request.releaseId) throw new Error(`release changed during ${event.requestId}`);
  if (event.processAttempt !== request.processAttempt) throw new Error(`process attempt changed during ${event.requestId}`);
  if (event.routingRevision !== request.routingRevision || event.routingFullFingerprint !== request.routingFullFingerprint) {
    throw new Error(`routing revision changed during ${event.requestId}`);
  }
  if (event.workloadVersion !== request.workloadVersion || event.workloadUsersDigest !== request.workloadUsersDigest) {
    throw new Error(`workload changed during ${event.requestId}`);
  }
}

function acquireLock(path: string): number {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out acquiring runtime journal lock ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
}

function releaseLock(path: string, descriptor: number): void {
  closeSync(descriptor);
  try {
    unlinkSync(`${path}.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class FileRuntimeEventJournal extends RuntimeEventJournal {
  constructor(private readonly path: string, events: readonly RuntimeEvent[] = []) {
    super(events);
  }

  static async open(path: string): Promise<FileRuntimeEventJournal> {
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RuntimeEvent);
    return new FileRuntimeEventJournal(path, events);
  }

  override append(event: NewRuntimeEvent): RuntimeEvent {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = acquireLock(this.path);
    try {
      let current: RuntimeEvent[] = [];
      try {
        current = readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RuntimeEvent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const authoritative = new RuntimeEventJournal(current);
      const persisted = authoritative.append(event);
      appendFileSync(this.path, `${JSON.stringify(persisted)}\n`, { encoding: "utf8", mode: 0o600 });
      this.events.length = 0;
      this.events.push(...authoritative.events);
      return persisted;
    } finally {
      releaseLock(this.path, lock);
    }
  }
}

export function startedEvent(input: {
  readonly requestId: string;
  readonly userId: string;
  readonly assignment: RoutingDecision;
  readonly processAttempt: number;
  readonly binding: RequestBinding;
  readonly at: string;
}): Omit<RequestStartedEvent, "sequence"> {
  return {
    type: "request_started",
    factoryRunId: input.assignment.factoryRunId,
    at: input.at,
    ...input.binding,
    requestId: input.requestId,
    userId: input.userId,
    target: input.assignment.target,
    releaseId: input.assignment.releaseId,
    processAttempt: input.processAttempt,
    bucket: input.assignment.bucket,
    candidateBasisPoints: input.assignment.candidateBasisPoints,
    configFingerprint: input.assignment.configFingerprint
  };
}

export { RuntimeEventJournal as RequestJournal, FileRuntimeEventJournal as FileRequestJournal };
