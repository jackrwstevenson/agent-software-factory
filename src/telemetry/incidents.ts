import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { ObservedCondition } from "./assessment.js";
import type { IncidentSeverity } from "./condition-policy.js";

export type IncidentState = "open" | "mitigated" | "resolved";

export interface IncidentRecord {
  readonly incidentId: string;
  readonly deduplicationKey: string;
  readonly conditionId: ObservedCondition["conditionId"];
  severity: IncidentSeverity;
  state: IncidentState;
  readonly affected: Readonly<Record<string, unknown>>;
  readonly recurrenceOf: string | null;
  readonly openedSampleSequence: number;
  lastSampleSequence: number;
  readonly firstWindowId: string;
  lastWindowId: string;
  evidence: Readonly<Record<string, unknown>>[];
  cleanStreak: number;
  readonly cleanWindowsToResolve: number;
  conditionWindowCount: number;
  lastConditionPresent: boolean;
  resolution: Readonly<Record<string, unknown>> | null;
  mitigation: Readonly<Record<string, unknown>> | null;
}

export interface IncidentSummary {
  readonly incidentId: string;
  readonly deduplicationKey: string;
  readonly conditionId: ObservedCondition["conditionId"];
  readonly severity: IncidentSeverity;
  readonly affected: Readonly<Record<string, unknown>>;
  readonly cleanStreak: number;
  readonly conditionWindowCount: number;
  readonly lastConditionPresent: boolean;
}

export type IncidentTransition =
  | Readonly<{ kind: "open"; condition: ObservedCondition }>
  | Readonly<{
    kind: "update";
    deduplicationKey: string;
    conditionId: ObservedCondition["conditionId"];
    severity: IncidentSeverity;
    evidence: Readonly<Record<string, unknown>>;
    conditionPresent: boolean;
    nextCleanStreak: number;
  }>
  | Readonly<{
    kind: "resolve";
    deduplicationKey: string;
    conditionId: ObservedCondition["conditionId"];
    evidence: Readonly<Record<string, unknown>>;
    nextCleanStreak: number;
    resolutionKind: "condition_cleared" | "cursor_reconciled";
  }>
  | Readonly<{
    kind: "mitigate";
    deduplicationKey: string;
    conditionId: ObservedCondition["conditionId"];
    evidence: Readonly<Record<string, unknown>>;
  }>;

interface AppliedTransition {
  readonly sequence: number;
  readonly sampleSequence: number;
  readonly windowId: string;
  readonly transition: IncidentTransition;
  readonly result: Readonly<Record<string, unknown>>;
  readonly resultingStoreDigest: string;
}

export interface IncidentStoreSnapshot {
  readonly schemaVersion: "incident-store/v1";
  readonly records: readonly IncidentRecord[];
  readonly transitions: readonly AppliedTransition[];
  readonly storeDigest: string;
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

export class IncidentStore {
  readonly #records: IncidentRecord[] = [];
  readonly #transitions: AppliedTransition[] = [];

  public get records(): readonly IncidentRecord[] {
    return immutableClone(this.#records);
  }

  public openByKey(key: string): IncidentRecord | null {
    return this.#records.find((record) => record.deduplicationKey === key && record.state === "open") ?? null;
  }

  public latestByKey(key: string): IncidentRecord | null {
    return [...this.#records].reverse().find((record) => record.deduplicationKey === key) ?? null;
  }

  public openSummaries(): readonly IncidentSummary[] {
    return immutableClone(this.#records
      .filter((record) => record.state === "open")
      .map((record) => Object.freeze({
        incidentId: record.incidentId,
        deduplicationKey: record.deduplicationKey,
        conditionId: record.conditionId,
        severity: record.severity,
        affected: clone(record.affected),
        cleanStreak: record.cleanStreak,
        conditionWindowCount: record.conditionWindowCount,
        lastConditionPresent: record.lastConditionPresent
      }))
      .sort((left, right) => left.incidentId.localeCompare(right.incidentId)));
  }

  public applyTransition(
    transition: IncidentTransition,
    sampleSequence: number,
    windowId: string
  ): Readonly<Record<string, unknown>> {
    let result: Readonly<Record<string, unknown>>;
    if (transition.kind === "open") {
      const condition = transition.condition;
      if (this.openByKey(condition.deduplicationKey) !== null) {
        throw new Error(`incident already open for ${condition.conditionId}`);
      }
      const latest = this.latestByKey(condition.deduplicationKey);
      const incidentId = `inc_${String(this.#records.length + 1).padStart(4, "0")}`;
      const record: IncidentRecord = {
        incidentId,
        deduplicationKey: condition.deduplicationKey,
        conditionId: condition.conditionId,
        severity: condition.severity,
        state: "open",
        affected: clone(condition.affected),
        recurrenceOf: latest?.incidentId ?? null,
        openedSampleSequence: sampleSequence,
        lastSampleSequence: sampleSequence,
        firstWindowId: windowId,
        lastWindowId: windowId,
        evidence: [clone(condition.evidence)],
        cleanStreak: 0,
        cleanWindowsToResolve: condition.cleanWindowsToResolve,
        conditionWindowCount: 1,
        lastConditionPresent: true,
        resolution: null,
        mitigation: null
      };
      this.#records.push(record);
      result = Object.freeze({ kind: "opened", incidentId, recurrenceOf: record.recurrenceOf });
    } else {
      const record = this.openByKey(transition.deduplicationKey);
      if (record === null) throw new Error(`no open incident for ${transition.conditionId}`);
      record.lastSampleSequence = sampleSequence;
      record.lastWindowId = windowId;
      if (transition.kind === "update") {
        record.severity = transition.severity;
        record.evidence.push(clone(transition.evidence));
        record.cleanStreak = transition.conditionPresent ? 0 : transition.nextCleanStreak;
        if (transition.conditionPresent) record.conditionWindowCount += 1;
        record.lastConditionPresent = transition.conditionPresent;
        result = Object.freeze({ kind: "updated", incidentId: record.incidentId, cleanStreak: record.cleanStreak });
      } else if (transition.kind === "mitigate") {
        record.state = "mitigated";
        record.lastConditionPresent = false;
        record.mitigation = Object.freeze(clone(transition.evidence));
        result = Object.freeze({ kind: "mitigated", incidentId: record.incidentId });
      } else {
        record.state = "resolved";
        record.cleanStreak = transition.nextCleanStreak;
        record.lastConditionPresent = false;
        record.resolution = Object.freeze({
          kind: transition.resolutionKind,
          sampleSequence,
          windowId,
          evidence: clone(transition.evidence)
        });
        result = Object.freeze({ kind: "resolved", incidentId: record.incidentId });
      }
    }
    const appliedWithoutDigest = {
      sequence: this.#transitions.length + 1,
      sampleSequence,
      windowId,
      transition: clone(transition),
      result: clone(result)
    };
    const applied: AppliedTransition = Object.freeze({
      ...appliedWithoutDigest,
      resultingStoreDigest: canonicalSha256(this.#records)
    });
    this.#transitions.push(applied);
    return result;
  }

  public mitigateCandidateIncidents(input: Readonly<{
    sampleSequence: number;
    windowId: string;
    stableOnlyRoutingRevisionId: string;
    stableHealthEvidenceDigest: string;
  }>): readonly string[] {
    const mitigated: string[] = [];
    for (const record of [...this.#records]) {
      if (record.state !== "open" || !record.conditionId.startsWith("candidate.")) continue;
      this.applyTransition(Object.freeze({
        kind: "mitigate",
        deduplicationKey: record.deduplicationKey,
        conditionId: record.conditionId,
        evidence: Object.freeze({
          kind: "stable_restored_without_candidate_recovery_claim",
          stableOnlyRoutingRevisionId: input.stableOnlyRoutingRevisionId,
          stableHealthEvidenceDigest: input.stableHealthEvidenceDigest
        })
      }), input.sampleSequence, input.windowId);
      mitigated.push(record.incidentId);
    }
    return Object.freeze(mitigated);
  }

  public digest(): string {
    return canonicalSha256(this.#records);
  }

  public snapshot(): IncidentStoreSnapshot {
    const core = {
      schemaVersion: "incident-store/v1" as const,
      records: immutableClone(this.#records),
      transitions: immutableClone(this.#transitions)
    };
    return Object.freeze({ ...core, storeDigest: canonicalSha256(core) });
  }

  public static replay(snapshot: IncidentStoreSnapshot): IncidentStore {
    const { storeDigest: _digest, ...core } = snapshot;
    if (canonicalSha256(core) !== snapshot.storeDigest) throw new Error("incident store snapshot digest mismatch");
    const replayed = new IncidentStore();
    for (const applied of snapshot.transitions) {
      const result = replayed.applyTransition(applied.transition, applied.sampleSequence, applied.windowId);
      if (canonicalSha256(result) !== canonicalSha256(applied.result)) {
        throw new Error(`incident replay result mismatch at transition ${applied.sequence}`);
      }
      if (replayed.digest() !== applied.resultingStoreDigest) {
        throw new Error(`incident replay digest mismatch at transition ${applied.sequence}`);
      }
    }
    if (canonicalSha256(replayed.records) !== canonicalSha256(snapshot.records)) {
      throw new Error("incident replay records mismatch");
    }
    return replayed;
  }
}
