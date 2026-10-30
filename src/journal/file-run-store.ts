import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  applyFactoryRunCommand,
  type FactoryRunCommand,
  type FactoryRunState
} from "../domain/factory-run.js";
import { canonicalJson, canonicalSha256 } from "../protocol/canonical-json.js";
import type {
  Digest,
  EffectIntentId,
  EventId,
  FactoryRunId
} from "../protocol/contracts.js";
import { validateProtocol } from "../protocol/schemas.js";

export type EffectPort =
  | "GitHubControl"
  | "SourceControl"
  | "RoleRuntime"
  | "ReleaseTopology"
  | "TelemetryEngine";

export interface AppendRunEventRequest {
  readonly expectedVersion: number;
  readonly eventId: EventId;
  readonly recordedAt: string;
  readonly command: FactoryRunCommand;
}

export interface EffectBinding {
  readonly effectIntentId: EffectIntentId;
  readonly port: EffectPort;
  readonly operation: string;
}

export interface AppendEffectIntentRequest {
  readonly expectedVersion: number;
  readonly eventId: EventId;
  readonly recordedAt: string;
  readonly effect: EffectBinding;
  readonly inputDigest: Digest;
}

export interface AppendEffectResultRequest {
  readonly expectedVersion: number;
  readonly eventId: EventId;
  readonly recordedAt: string;
  readonly effect: EffectBinding;
  readonly outputDigest: Digest;
}

export type RunRecord =
  | { readonly kind: "lifecycle_command"; readonly command: FactoryRunCommand }
  | {
      readonly kind: "effect_intent";
      readonly effect: EffectBinding;
      readonly inputDigest: Digest;
    }
  | {
      readonly kind: "effect_result";
      readonly effect: EffectBinding;
      readonly outputDigest: Digest;
    };

export interface RunEvent {
  readonly schemaVersion: "1.0";
  readonly contract: "run_event";
  readonly sequence: number;
  readonly eventId: EventId;
  readonly factoryRunId: FactoryRunId;
  readonly recordedAt: string;
  readonly expectedVersion: number;
  readonly previousEventDigest: Digest | null;
  readonly record: RunRecord;
  readonly resultingStateDigest: Digest;
  readonly eventDigest: Digest;
}

export interface EffectProjection {
  readonly effect: EffectBinding;
  readonly inputDigest: Digest;
  readonly status: "pending" | "succeeded";
  readonly outputDigest: Digest | null;
}

export interface RunSnapshot {
  readonly schemaVersion: "1.0";
  readonly contract: "run_snapshot";
  readonly version: number;
  readonly state: FactoryRunState;
  readonly stateDigest: Digest;
  readonly effects: readonly EffectProjection[];
  readonly lastEventDigest: Digest;
}

export interface RunStore {
  load(): Promise<RunSnapshot | null>;
  append(request: AppendRunEventRequest): Promise<RunSnapshot>;
  appendEffectIntent(request: AppendEffectIntentRequest): Promise<RunSnapshot>;
  appendEffectResult(request: AppendEffectResultRequest): Promise<RunSnapshot>;
  rebuildSnapshot(): Promise<RunSnapshot>;
}

export type JournalErrorCode =
  | "EXPECTED_VERSION_MISMATCH"
  | "EMPTY_JOURNAL"
  | "INVALID_EVENT"
  | "SEQUENCE_GAP"
  | "DIGEST_MISMATCH"
  | "DOMAIN_REJECTION"
  | "EFFECT_CONFLICT";

export class JournalError extends Error {
  readonly code: JournalErrorCode;

  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

function snapshotFor(
  state: FactoryRunState,
  lastEventDigest: Digest,
  version: number,
  effects: readonly EffectProjection[]
): RunSnapshot {
  return {
    schemaVersion: "1.0",
    contract: "run_snapshot",
    version,
    state,
    stateDigest: canonicalSha256(state),
    effects,
    lastEventDigest
  };
}

function acceptEffectRecord(
  effects: readonly EffectProjection[],
  record: Extract<RunRecord, { kind: "effect_intent" | "effect_result" }>
): readonly EffectProjection[] {
  const existingIndex = effects.findIndex((effect) => effect.effect.effectIntentId === record.effect.effectIntentId);
  if (record.kind === "effect_intent") {
    if (existingIndex !== -1) {
      throw new JournalError("EFFECT_CONFLICT", `duplicate effect intent ${record.effect.effectIntentId}`);
    }
    return [
      ...effects,
      {
        effect: record.effect,
        inputDigest: record.inputDigest,
        status: "pending",
        outputDigest: null
      }
    ];
  }

  if (existingIndex === -1) {
    throw new JournalError("EFFECT_CONFLICT", `effect result has no intent ${record.effect.effectIntentId}`);
  }
  const existing = effects[existingIndex];
  if (
    existing === undefined ||
    existing.effect.port !== record.effect.port ||
    existing.effect.operation !== record.effect.operation ||
    existing.status !== "pending"
  ) {
    throw new JournalError("EFFECT_CONFLICT", `effect result conflicts with intent ${record.effect.effectIntentId}`);
  }
  return effects.map((effect, index) =>
    index === existingIndex
      ? { ...effect, status: "succeeded" as const, outputDigest: record.outputDigest }
      : effect
  );
}

function requireProtocol(schema: "run-event" | "run-snapshot", value: unknown): void {
  const validation = validateProtocol(schema, value);
  if (!validation.ok) {
    throw new JournalError(
      "INVALID_EVENT",
      `${schema} contract violation: ${validation.errors.join("; ")}`
    );
  }
}

export function replayRunEvents(events: readonly RunEvent[]): RunSnapshot | null {
  let state: FactoryRunState | null = null;
  let effects: readonly EffectProjection[] = [];
  let previousEventDigest: Digest | null = null;

  for (const [index, event] of events.entries()) {
    requireProtocol("run-event", event);
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence || event.expectedVersion !== expectedSequence - 1) {
      throw new JournalError(
        "SEQUENCE_GAP",
        `expected sequence ${expectedSequence} at event ${event.eventId}`
      );
    }
    if (event.previousEventDigest !== previousEventDigest) {
      throw new JournalError("DIGEST_MISMATCH", `previous digest mismatch at ${event.eventId}`);
    }
    const { eventDigest, ...withoutDigest } = event;
    if (canonicalSha256(withoutDigest) !== eventDigest) {
      throw new JournalError("DIGEST_MISMATCH", `event digest mismatch at ${event.eventId}`);
    }

    if (event.record.kind === "lifecycle_command") {
      const result = applyFactoryRunCommand(state, event.record.command);
      if (!result.ok) {
        throw new JournalError(
          "DOMAIN_REJECTION",
          `${event.eventId}: ${result.error.code}: ${result.error.message}`
        );
      }
      state = result.state;
    } else {
      if (state === null) {
        throw new JournalError("INVALID_EVENT", "effect records require an accepted Factory Run");
      }
      effects = acceptEffectRecord(effects, event.record);
    }

    if (state.factoryRunId !== event.factoryRunId) {
      throw new JournalError("INVALID_EVENT", `Factory Run binding mismatch at ${event.eventId}`);
    }
    const stateDigest = canonicalSha256(state);
    if (stateDigest !== event.resultingStateDigest) {
      throw new JournalError("DIGEST_MISMATCH", `state digest mismatch at ${event.eventId}`);
    }
    previousEventDigest = event.eventDigest;
  }

  if (state === null || previousEventDigest === null) return null;
  return snapshotFor(state, previousEventDigest, events.length, effects);
}

export class FileRunStore implements RunStore {
  readonly #eventsPath: string;
  readonly #snapshotPath: string;
  readonly #runDirectory: string;

  constructor(runDirectory: string) {
    this.#runDirectory = runDirectory;
    this.#eventsPath = join(runDirectory, "run-events.ndjson");
    this.#snapshotPath = join(runDirectory, "run-snapshot.json");
  }

  async load(): Promise<RunSnapshot | null> {
    const events = await this.#readEvents();
    const snapshot = replayRunEvents(events);
    if (snapshot !== null) await this.#writeSnapshot(snapshot);
    return snapshot;
  }

  async append(request: AppendRunEventRequest): Promise<RunSnapshot> {
    return this.#appendRecord({
      expectedVersion: request.expectedVersion,
      eventId: request.eventId,
      recordedAt: request.recordedAt,
      record: { kind: "lifecycle_command", command: request.command }
    });
  }

  async appendEffectIntent(request: AppendEffectIntentRequest): Promise<RunSnapshot> {
    return this.#appendRecord({
      expectedVersion: request.expectedVersion,
      eventId: request.eventId,
      recordedAt: request.recordedAt,
      record: {
        kind: "effect_intent",
        effect: request.effect,
        inputDigest: request.inputDigest
      }
    });
  }

  async appendEffectResult(request: AppendEffectResultRequest): Promise<RunSnapshot> {
    return this.#appendRecord({
      expectedVersion: request.expectedVersion,
      eventId: request.eventId,
      recordedAt: request.recordedAt,
      record: {
        kind: "effect_result",
        effect: request.effect,
        outputDigest: request.outputDigest
      }
    });
  }

  async rebuildSnapshot(): Promise<RunSnapshot> {
    const snapshot = await this.load();
    if (snapshot === null) {
      throw new JournalError("EMPTY_JOURNAL", "cannot rebuild a snapshot from an empty journal");
    }
    return snapshot;
  }

  async #appendRecord(request: {
    readonly expectedVersion: number;
    readonly eventId: EventId;
    readonly recordedAt: string;
    readonly record: RunRecord;
  }): Promise<RunSnapshot> {
    await mkdir(this.#runDirectory, { recursive: true, mode: 0o700 });
    const current = await this.load();
    const actualVersion = current?.version ?? 0;
    if (request.expectedVersion !== actualVersion) {
      throw new JournalError(
        "EXPECTED_VERSION_MISMATCH",
        `expected version ${request.expectedVersion}, found ${actualVersion}`
      );
    }

    let state = current?.state ?? null;
    let effects = current?.effects ?? [];
    if (request.record.kind === "lifecycle_command") {
      const result = applyFactoryRunCommand(state, request.record.command);
      if (!result.ok) {
        throw new JournalError(
          "DOMAIN_REJECTION",
          `${result.error.code}: ${result.error.message}`
        );
      }
      state = result.state;
    } else {
      if (state === null) {
        throw new JournalError("INVALID_EVENT", "effect records require an accepted Factory Run");
      }
      effects = acceptEffectRecord(effects, request.record);
    }

    const sequence = actualVersion + 1;
    const withoutDigest: Omit<RunEvent, "eventDigest"> = {
      schemaVersion: "1.0",
      contract: "run_event",
      sequence,
      eventId: request.eventId,
      factoryRunId: state.factoryRunId,
      recordedAt: request.recordedAt,
      expectedVersion: actualVersion,
      previousEventDigest: current?.lastEventDigest ?? null,
      record: request.record,
      resultingStateDigest: canonicalSha256(state)
    };
    const event: RunEvent = {
      ...withoutDigest,
      eventDigest: canonicalSha256(withoutDigest)
    };
    requireProtocol("run-event", event);

    const handle = await open(this.#eventsPath, "a", 0o600);
    try {
      await handle.write(`${canonicalJson(event)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    const snapshot = snapshotFor(state, event.eventDigest, sequence, effects);
    await this.#writeSnapshot(snapshot);
    return snapshot;
  }

  async #readEvents(): Promise<readonly RunEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.#eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (contents.length === 0) return [];
    if (!contents.endsWith("\n")) {
      throw new JournalError("INVALID_EVENT", "run-events.ndjson ends with a partial record");
    }
    return contents
      .slice(0, -1)
      .split("\n")
      .map((line, index) => {
        try {
          return JSON.parse(line) as RunEvent;
        } catch {
          throw new JournalError("INVALID_EVENT", `invalid JSON at sequence ${index + 1}`);
        }
      });
  }

  async #writeSnapshot(snapshot: RunSnapshot): Promise<void> {
    requireProtocol("run-snapshot", snapshot);
    await mkdir(this.#runDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#snapshotPath}.${process.pid}.tmp`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.write(`${canonicalJson(snapshot)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#snapshotPath);
  }
}
