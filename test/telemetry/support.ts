import { canonicalSha256 } from "../../src/protocol/canonical-json.js";
import {
  AcceptedEventJournal,
  createTelemetryEvent,
  createTelemetryWindowBinding,
  eventBindingFromWindow,
  gatePolicy,
  processIdentity,
  telemetrySourceBaseKey,
  type ComponentName,
  processKindForComponent,
  type ProcessIdentity,
  type RequestArm,
  type RolloutGate,
  type RequestAttemptOutcome,
  type TelemetryEventDraft,
  type TelemetryEventPayloadMap,
  type TelemetryEventType,
  type TelemetryPhase,
  type TelemetrySource,
  type TelemetryWindowBinding
} from "../../src/telemetry/index.js";

const START = Date.parse("2026-09-29T09:00:00.000Z");

function phaseForGate(gate: RolloutGate): TelemetryPhase {
  if (gate === "staging") return "staging";
  if (gate === "stable_reference") return "stable_reference";
  if (gate === "observation") return "observation";
  return "rollout";
}

function component(factoryRunId: string, name: ComponentName, epoch: number): ProcessIdentity {
  const releaseId = name === "stable"
    ? "stable-release"
    : name === "candidate" || name === "staging"
      ? "candidate-release"
      : null;
  const ordinal = ["stable", "candidate", "staging", "router", "traffic"].indexOf(name) + 1;
  return processIdentity({
    factoryRunId,
    instanceId: `${name}-instance-${epoch}`,
    processKind: processKindForComponent(name),
    processAttempt: epoch,
    releaseId,
    endpointId: `${name}-endpoint-${epoch}`,
    ownershipNonce: ordinal.toString(16).repeat(48),
    pid: 10_000 + epoch * 10 + ordinal,
    processBirthIdentity: `${name}-birth-${epoch}`
  });
}

export class TelemetryRunBuilder {
  readonly factoryRunId: string;
  readonly journal: AcceptedEventJournal;
  readonly orchestrator: TelemetrySource;
  readonly supervisor: TelemetrySource;
  readonly traffic: TelemetrySource;
  #eventOrdinal = 0;
  #sourceSequences = new Map<string, number>();
  nowMs = 0;

  public constructor(suffix: string) {
    this.factoryRunId = `fr_${suffix.replaceAll(/[^a-z0-9_-]/g, "_")}`;
    this.journal = new AcceptedEventJournal(this.factoryRunId);
    this.orchestrator = { kind: "orchestrator", instanceId: "orchestrator-1", processAttempt: "attempt-1", sourceSequence: 0 };
    this.supervisor = { kind: "supervisor", instanceId: "supervisor-1", processAttempt: "attempt-1", sourceSequence: 0 };
    this.traffic = { kind: "synthetic_traffic", instanceId: "traffic-1", processAttempt: "attempt-1", sourceSequence: 0 };
  }

  public sourceCursor(source: TelemetrySource): number {
    return this.#sourceSequences.get(telemetrySourceBaseKey(source)) ?? 0;
  }

  public skipSourceSequence(source: TelemetrySource, count = 1): void {
    const key = telemetrySourceBaseKey(source);
    this.#sourceSequences.set(key, this.sourceCursor(source) + count);
  }

  public emit<K extends TelemetryEventType>(
    source: TelemetrySource,
    binding: TelemetryWindowBinding,
    eventType: K,
    payload: Readonly<TelemetryEventPayloadMap[K]>
  ): void {
    this.#eventOrdinal += 1;
    const key = telemetrySourceBaseKey(source);
    const sourceSequence = this.sourceCursor(source) + 1;
    this.#sourceSequences.set(key, sourceSequence);
    const event = createTelemetryEvent({
      eventId: `te_${String(this.#eventOrdinal).padStart(5, "0")}`,
      factoryRunId: this.factoryRunId,
      occurredAt: new Date(START + this.nowMs).toISOString(),
      monotonicMs: this.nowMs,
      source: { ...source, sourceSequence },
      windowId: binding.windowId,
      eventType,
      binding: eventBindingFromWindow(binding),
      payload
    } as unknown as TelemetryEventDraft<K>);
    this.journal.accept(event);
  }

  public createWindow(
    name: string,
    gate: RolloutGate = "gate_50",
    options: Readonly<{
      topologyEpoch?: number;
      requestedIntervalMs?: number;
      collectionDeadlineMs?: number;
      stableProcessAttempt?: number;
      stableReleaseId?: string;
      candidateReleaseId?: string;
      pinnedStableReferenceWindowId?: string | null;
    }> = {}
  ): WindowFixture {
    const policy = gatePolicy(gate);
    const epoch = options.topologyEpoch ?? 1;
    const components: Partial<Record<ComponentName, ProcessIdentity>> = {
      stable: component(this.factoryRunId, "stable", epoch),
      candidate: component(this.factoryRunId, "candidate", epoch),
      staging: component(this.factoryRunId, "staging", epoch),
      router: component(this.factoryRunId, "router", epoch),
      traffic: component(this.factoryRunId, "traffic", epoch)
    };
    if (options.stableProcessAttempt !== undefined && components.stable !== undefined) {
      components.stable = processIdentity({ ...components.stable, processAttempt: options.stableProcessAttempt });
    }
    if (options.stableReleaseId !== undefined && components.stable !== undefined) {
      components.stable = processIdentity({ ...components.stable, releaseId: options.stableReleaseId });
    }
    if (options.candidateReleaseId !== undefined) {
      if (components.candidate !== undefined) components.candidate = processIdentity({ ...components.candidate, releaseId: options.candidateReleaseId });
      if (components.staging !== undefined) components.staging = processIdentity({ ...components.staging, releaseId: options.candidateReleaseId });
    }
    const candidateBasisPoints = policy.candidateBasisPoints ?? 10_000;
    const requiredComponents: readonly ComponentName[] = gate === "staging"
      ? ["staging"]
      : ["stable", "candidate", "router", "traffic"];
    const revisionManifest = {
      routingRevisionId: `rr_${name}`,
      topologyEpoch: epoch,
      candidateBasisPoints,
      stable: components.stable,
      candidate: components.candidate,
      workloadId: "synthetic-traffic/v1",
      workloadDigest: "b".repeat(64)
    };
    const routingConfigFingerprint = canonicalSha256(revisionManifest);
    const binding = createTelemetryWindowBinding({
      factoryRunId: this.factoryRunId,
      windowId: `tw_${name}`,
      topologyEpoch: epoch,
      routingRevisionId: `rr_${name}`,
      routingConfigFingerprint,
      phase: phaseForGate(gate),
      gate,
      candidateBasisPoints,
      stableReleaseId: options.stableReleaseId ?? "stable-release",
      candidateReleaseId: options.candidateReleaseId ?? "candidate-release",
      workloadId: "synthetic-traffic/v1",
      workloadDigest: "b".repeat(64),
      policyId: "rollout-policy/v1",
      requestedIntervalMs: options.requestedIntervalMs ?? policy.minimumDurationMs,
      collectionDeadlineMs: options.collectionDeadlineMs ?? policy.collectionDeadlineMs,
      components,
      requiredComponents,
      sourceCursorsAtOpen: {
        [telemetrySourceBaseKey(this.supervisor)]: this.sourceCursor(this.supervisor),
        [telemetrySourceBaseKey(this.traffic)]: this.sourceCursor(this.traffic)
      },
      pinnedStableReferenceWindowId: options.pinnedStableReferenceWindowId ?? null
    });
    return new WindowFixture(this, binding, revisionManifest);
  }
}

export class WindowFixture {
  #requestOrdinal = 0;
  #opened = false;
  #closed = false;
  #openedAtMs = 0;

  public constructor(
    readonly run: TelemetryRunBuilder,
    readonly binding: TelemetryWindowBinding,
    readonly revisionManifest: Readonly<Record<string, unknown>>
  ) {}

  public open(): this {
    this.#openedAtMs = this.run.nowMs;
    this.run.emit(this.run.orchestrator, this.binding, "routing_revision_applied", {
      observedFingerprint: this.binding.routingConfigFingerprint,
      revisionManifest: this.revisionManifest
    });
    this.run.emit(this.run.orchestrator, this.binding, "telemetry_window_opened", {
      binding: this.binding,
      bindingDigest: this.binding.bindingDigest
    });
    this.#opened = true;
    return this;
  }

  public addHealth(componentName: ComponentName, states: readonly ("healthy" | "unhealthy")[], options: Readonly<{
    identityMismatchAt?: number;
    reportedRoutingRevisionId?: string;
  }> = {}): this {
    const identity = this.binding.components[componentName];
    if (identity === undefined) throw new Error(`missing component ${componentName}`);
    states.forEach((state, index) => {
      this.run.nowMs += 1;
      const reportedIdentity = options.identityMismatchAt === index
        ? { ...identity, processAttempt: identity.processAttempt + 1_000 }
        : identity;
      this.run.emit(this.run.supervisor, this.binding, "process_health_sampled", {
        component: reportedIdentity,
        healthy: state === "healthy",
        reason: state === "healthy" ? null : "probe_failed",
        reportedRoutingRevisionId: componentName === "router"
          ? options.reportedRoutingRevisionId ?? this.binding.routingRevisionId
          : null
      });
    });
    return this;
  }

  public addHealthyRequiredComponents(sampleCount?: number): this {
    const count = sampleCount ?? Math.max(3, Math.floor(this.binding.requestedIntervalMs / 1_000) + 1);
    for (const componentName of this.binding.requiredComponents) {
      this.addHealth(componentName, Array.from({ length: count }, () => "healthy" as const));
    }
    return this;
  }

  public addProcessExit(componentName: ComponentName): this {
    const identity = this.binding.components[componentName];
    if (identity === undefined) throw new Error(`missing component ${componentName}`);
    this.run.emit(this.run.supervisor, this.binding, "process_exited", {
      component: identity,
      expected: false,
      exitCode: 17,
      signal: null
    });
    return this;
  }

  public addRequests(arm: RequestArm, count: number, options: Readonly<{
    durationMs?: number | ((index: number) => number);
    attemptOutcomes?: readonly RequestAttemptOutcome[] | ((index: number) => readonly RequestAttemptOutcome[]);
    finalOutcome?: "success" | "failed";
    uniqueUsers?: number;
    responseIdentityVerified?: boolean;
  }> = {}): this {
    for (let index = 0; index < count; index += 1) {
      const attemptOutcomes = typeof options.attemptOutcomes === "function"
        ? options.attemptOutcomes(index)
        : options.attemptOutcomes;
      const durationMs = typeof options.durationMs === "function"
        ? options.durationMs(index)
        : options.durationMs;
      this.addRequest(arm, {
        index,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(attemptOutcomes === undefined ? {} : { attemptOutcomes }),
        ...(options.finalOutcome === undefined ? {} : { finalOutcome: options.finalOutcome }),
        userIndex: options.uniqueUsers === undefined ? index : index % options.uniqueUsers,
        ...(options.responseIdentityVerified === undefined ? {} : { responseIdentityVerified: options.responseIdentityVerified })
      });
    }
    return this;
  }

  public addRequest(arm: RequestArm, options: Readonly<{
    index?: number;
    userIndex?: number;
    durationMs?: number;
    attemptOutcomes?: readonly RequestAttemptOutcome[];
    finalOutcome?: "success" | "failed";
    responseIdentityVerified?: boolean;
  }> = {}): this {
    this.#requestOrdinal += 1;
    const identity = this.binding.components[arm];
    if (identity === undefined) throw new Error(`missing arm ${arm}`);
    const requestId = `${this.binding.windowId}-request-${String(this.#requestOrdinal).padStart(4, "0")}`;
    const userIndex = options.userIndex ?? options.index ?? this.#requestOrdinal;
    const userId = `synthetic-user-${arm}-${String(userIndex).padStart(4, "0")}`;
    const exposure = this.binding.candidateBasisPoints;
    const bucket = arm === "candidate"
      ? Math.min(9_999, Math.max(0, userIndex % Math.max(1, exposure)))
      : Math.min(9_999, Math.max(exposure, exposure + (userIndex % Math.max(1, 10_000 - exposure))));
    const attempts = options.attemptOutcomes ?? ["success"];
    const finalOutcome = options.finalOutcome ?? (attempts.at(-1) === "success" ? "success" : "failed");
    const responseIdentityVerified = options.responseIdentityVerified ?? finalOutcome === "success";

    this.run.emit(this.run.traffic, this.binding, "request_started", {
      requestId,
      userId,
      operationId: "tiny-task:list",
      bucket,
      selectedArm: arm,
      selectedComponent: identity
    });
    attempts.forEach((outcome, attemptIndex) => {
      this.run.emit(this.run.traffic, this.binding, "request_attempt_finished", {
        requestId,
        attemptOrdinal: attemptIndex + 1,
        selectedArm: arm,
        selectedComponent: identity,
        outcome,
        statusCode: outcome === "success" ? 200 : 503,
        attemptLatencyMs: 10,
        responseIdentityVerified: outcome === "success" && responseIdentityVerified
      });
    });
    this.run.emit(this.run.traffic, this.binding, "request_finished", {
      requestId,
      selectedArm: arm,
      selectedComponent: identity,
      finalOutcome,
      attemptCount: attempts.length,
      durationMs: options.durationMs ?? attempts.length * 10,
      failureKind: finalOutcome === "failed" ? attempts.at(-1) ?? "failed" : null,
      responseIdentityVerified
    });
    return this;
  }

  public skipTrafficSourceSequence(count = 1): this {
    this.run.skipSourceSequence(this.run.traffic, count);
    return this;
  }

  public close(options: Readonly<{ elapsedMs?: number; inFlightRequests?: number; reason?: string }> = {}): this {
    if (!this.#opened || this.#closed) throw new Error(`${this.binding.windowId} is not open`);
    this.run.nowMs = Math.max(
      this.run.nowMs,
      this.#openedAtMs + (options.elapsedMs ?? this.binding.requestedIntervalMs)
    );
    this.run.emit(this.run.orchestrator, this.binding, "telemetry_window_closed", {
      bindingDigest: this.binding.bindingDigest,
      reason: options.reason ?? "gate_evaluation",
      inFlightRequests: options.inFlightRequests ?? 0,
      sourceCursorsAtClose: {
        [telemetrySourceBaseKey(this.run.supervisor)]: this.run.sourceCursor(this.run.supervisor),
        [telemetrySourceBaseKey(this.run.traffic)]: this.run.sourceCursor(this.run.traffic)
      }
    });
    this.#closed = true;
    return this;
  }
}

export function populateHealthyWindow(window: WindowFixture, options: Readonly<{
  stableRequests?: number;
  candidateRequests?: number;
  stableLatencyMs?: number;
  candidateLatencyMs?: number;
}> = {}): WindowFixture {
  const policy = gatePolicy(window.binding.gate);
  window.addHealthyRequiredComponents();
  const stableRequests = options.stableRequests ?? policy.stable?.minimumFinishedRequests ?? 0;
  const candidateRequests = options.candidateRequests ?? policy.candidate?.minimumFinishedRequests ?? 0;
  if (stableRequests > 0) window.addRequests("stable", stableRequests, { durationMs: options.stableLatencyMs ?? 10 });
  if (candidateRequests > 0) window.addRequests("candidate", candidateRequests, { durationMs: options.candidateLatencyMs ?? 12 });
  return window.close();
}

export function createRollbackRestorationFixture(
  suffix: string,
  healthyProbeCount: number
): Readonly<{
  run: TelemetryRunBuilder;
  window: WindowFixture;
  stableIdentity: ProcessIdentity;
}> {
  const run = new TelemetryRunBuilder(suffix);
  const window = run.createWindow(`rollback_${suffix}`, "stable_reference").open();
  window.addHealth("stable", Array.from({ length: healthyProbeCount }, () => "healthy" as const));
  const stableIdentity = window.binding.components.stable;
  if (stableIdentity === undefined) throw new Error("rollback fixture requires Stable identity");
  return Object.freeze({ run, window, stableIdentity });
}
