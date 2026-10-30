import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  createTelemetryEvent,
  telemetrySourceIdentityKey,
  type AcceptedTelemetryEvent,
  type AcceptedTelemetryEventOf,
  type TelemetryEventDraft,
  type TelemetryEventInput,
  type TelemetryEventOf,
  type TelemetryEventType,
  type TelemetryProtocolConflict
} from "./contracts.js";

export class ProtocolConflict extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProtocolConflict";
  }
}

function acceptedToInput(event: AcceptedTelemetryEvent): TelemetryEventInput {
  return createTelemetryEvent({
    eventId: event.eventId,
    factoryRunId: event.factoryRunId,
    occurredAt: event.occurredAt,
    monotonicMs: event.monotonicMs,
    source: event.source,
    windowId: event.windowId,
    eventType: event.eventType,
    binding: event.binding,
    payloadDigest: event.payloadDigest,
    payload: event.payload
  } as TelemetryEventDraft<TelemetryEventType>) as TelemetryEventInput;
}

export interface AcceptedEventJournalCheckpoint {
  readonly schemaVersion: "telemetry-event-journal/v1";
  readonly factoryRunId: string;
  readonly events: readonly AcceptedTelemetryEvent[];
  readonly conflicts: readonly TelemetryProtocolConflict[];
  readonly journalDigest: string;
}

export class AcceptedEventJournal {
  readonly #events: AcceptedTelemetryEvent[] = [];
  readonly #bySourceIdentity = new Map<string, AcceptedTelemetryEvent>();
  readonly #byEventId = new Map<string, AcceptedTelemetryEvent>();
  readonly #conflicts: TelemetryProtocolConflict[] = [];

  public constructor(readonly factoryRunId: string) {
    if (factoryRunId.length === 0) throw new TypeError("Factory Run ID is required");
  }

  public accept<K extends TelemetryEventType>(
    input: TelemetryEventOf<K>
  ): Readonly<{ event: AcceptedTelemetryEventOf<K>; duplicate: boolean }> {
    if (input.factoryRunId !== this.factoryRunId) {
      throw new ProtocolConflict(`foreign Factory Run ${input.factoryRunId}`);
    }
    if (!Number.isInteger(input.source.sourceSequence) || input.source.sourceSequence < 1) {
      throw new ProtocolConflict("source sequence must be a positive integer");
    }
    const actualPayloadDigest = canonicalSha256(input.payload);
    const normalized = createTelemetryEvent({ ...input, payloadDigest: actualPayloadDigest } as TelemetryEventDraft<K>);
    const sourceEventDigest = canonicalSha256(normalized);
    const sourceIdentity = telemetrySourceIdentityKey(normalized.source);
    const existingBySource = this.#bySourceIdentity.get(sourceIdentity);
    const existingById = this.#byEventId.get(normalized.eventId);
    const existing = existingBySource ?? existingById;

    if (existing !== undefined) {
      if (
        input.payloadDigest === actualPayloadDigest
        && existing.eventId === normalized.eventId
        && existing.sourceEventDigest === sourceEventDigest
        && telemetrySourceIdentityKey(existing.source) === sourceIdentity
      ) {
        return Object.freeze({ event: existing as AcceptedTelemetryEventOf<K>, duplicate: true });
      }
      this.#conflicts.push(Object.freeze({
        windowId: normalized.windowId,
        eventId: normalized.eventId,
        sourceIdentity,
        existingDigest: existing.sourceEventDigest,
        conflictingDigest: sourceEventDigest
      }));
      throw new ProtocolConflict(`conflicting duplicate for ${normalized.eventId} / ${sourceIdentity}`);
    }

    if (input.payloadDigest !== actualPayloadDigest) {
      this.#conflicts.push(Object.freeze({
        windowId: normalized.windowId,
        eventId: normalized.eventId,
        sourceIdentity,
        existingDigest: input.payloadDigest,
        conflictingDigest: actualPayloadDigest
      }));
      throw new ProtocolConflict(`payload digest mismatch for ${normalized.eventId}`);
    }

    const accepted = Object.freeze({
      ...normalized,
      ingestSequence: this.#events.length + 1,
      ingestedAt: normalized.occurredAt,
      sourceEventDigest
    }) as unknown as AcceptedTelemetryEventOf<K>;
    this.#events.push(accepted);
    this.#bySourceIdentity.set(sourceIdentity, accepted);
    this.#byEventId.set(normalized.eventId, accepted);
    return Object.freeze({ event: accepted, duplicate: false });
  }

  public snapshot(): readonly AcceptedTelemetryEvent[] {
    return structuredClone(this.#events);
  }

  public conflictsForWindow(windowId: string): readonly TelemetryProtocolConflict[] {
    return structuredClone(this.#conflicts.filter((conflict) => conflict.windowId === windowId));
  }

  public digest(): string {
    return canonicalSha256({ events: this.#events, conflicts: this.#conflicts });
  }

  public checkpoint(): AcceptedEventJournalCheckpoint {
    const core = {
      schemaVersion: "telemetry-event-journal/v1" as const,
      factoryRunId: this.factoryRunId,
      events: this.snapshot(),
      conflicts: structuredClone(this.#conflicts)
    };
    return Object.freeze({ ...core, journalDigest: canonicalSha256(core) });
  }

  public static replayCheckpoint(checkpoint: AcceptedEventJournalCheckpoint): AcceptedEventJournal {
    const { journalDigest: _digest, ...core } = checkpoint;
    if (canonicalSha256(core) !== checkpoint.journalDigest) {
      throw new ProtocolConflict("telemetry journal checkpoint digest mismatch");
    }
    if (checkpoint.events.length === 0) {
      const empty = new AcceptedEventJournal(checkpoint.factoryRunId);
      empty.#conflicts.push(...structuredClone(checkpoint.conflicts));
      return empty;
    }
    const replayed = AcceptedEventJournal.replay(checkpoint.events);
    if (replayed.factoryRunId !== checkpoint.factoryRunId) {
      throw new ProtocolConflict("telemetry journal checkpoint Factory Run mismatch");
    }
    replayed.#conflicts.push(...structuredClone(checkpoint.conflicts));
    if (replayed.digest() !== canonicalSha256({ events: checkpoint.events, conflicts: checkpoint.conflicts })) {
      throw new ProtocolConflict("telemetry journal checkpoint replay mismatch");
    }
    return replayed;
  }

  public static replay(events: readonly AcceptedTelemetryEvent[]): AcceptedEventJournal {
    if (events.length === 0) throw new ProtocolConflict("cannot infer Factory Run from an empty replay");
    const first = events[0];
    if (first === undefined) throw new ProtocolConflict("missing first accepted event");
    const journal = new AcceptedEventJournal(first.factoryRunId);
    for (const [index, persisted] of events.entries()) {
      if (persisted.ingestSequence !== index + 1) {
        throw new ProtocolConflict(`ingest sequence gap at ${index + 1}`);
      }
      const input = acceptedToInput(persisted);
      if (canonicalSha256(input) !== persisted.sourceEventDigest) {
        throw new ProtocolConflict(`persisted source digest mismatch for ${persisted.eventId}`);
      }
      const accepted = journal.accept(input);
      if (accepted.duplicate) {
        throw new ProtocolConflict(`persisted journal repeats ${persisted.eventId}`);
      }
      if (accepted.event.ingestedAt !== persisted.ingestedAt) {
        throw new ProtocolConflict(`persisted ingest time mismatch for ${persisted.eventId}`);
      }
    }
    return journal;
  }
}
