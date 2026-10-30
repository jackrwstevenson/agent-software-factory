import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { AcceptedEventJournalCheckpoint } from "./accepted-event-journal.js";
import type { IncidentStoreSnapshot } from "./incidents.js";
import type { AcceptedObserverRecord, ObserverInput, ObserverResult, ObserverSessionSnapshot } from "./observer.js";
import type { RolloutBabysitterProposal } from "./rollout-babysitter.js";
import type { BabysitterWorkerInput } from "./worker-protocol.js";

export interface TelemetryEvaluationCheckpoint {
  readonly schemaVersion: "telemetry-evaluation-checkpoint/v1";
  readonly factoryRunId: string;
  readonly evaluationSequence: number;
  readonly journal: AcceptedEventJournalCheckpoint;
  readonly incidents: IncidentStoreSnapshot;
  readonly observer: ObserverSessionSnapshot;
  readonly observerInput: ObserverInput;
  readonly observerResult: ObserverResult;
  readonly acceptedObserverRecord: AcceptedObserverRecord;
  readonly babysitterInput: BabysitterWorkerInput;
  readonly babysitterResult: RolloutBabysitterProposal;
  readonly observerWorkerPid: number;
  readonly babysitterWorkerPid: number;
  readonly checkpointDigest: string;
}

export interface TelemetryCheckpointStore {
  load(factoryRunId: string): Promise<TelemetryEvaluationCheckpoint | null>;
  save(checkpoint: TelemetryEvaluationCheckpoint): Promise<void>;
}

export function sealTelemetryCheckpoint(
  input: Omit<TelemetryEvaluationCheckpoint, "schemaVersion" | "checkpointDigest">
): TelemetryEvaluationCheckpoint {
  const core = { schemaVersion: "telemetry-evaluation-checkpoint/v1" as const, ...input };
  return Object.freeze({ ...core, checkpointDigest: canonicalSha256(core) });
}

export function validateTelemetryCheckpoint(checkpoint: TelemetryEvaluationCheckpoint): void {
  const { checkpointDigest, ...core } = checkpoint;
  if (canonicalSha256(core) !== checkpointDigest) throw new Error("Telemetry checkpoint digest mismatch");
  if (checkpoint.factoryRunId !== checkpoint.journal.factoryRunId) throw new Error("Telemetry checkpoint Factory Run mismatch");
  if (checkpoint.acceptedObserverRecord.acceptedRecordDigest !== checkpoint.babysitterInput.acceptedObserverRecord.acceptedRecordDigest) {
    throw new Error("Telemetry checkpoint worker handoff mismatch");
  }
}

export class FileTelemetryCheckpointStore implements TelemetryCheckpointStore {
  public constructor(readonly path: string) {}

  public async load(factoryRunId: string): Promise<TelemetryEvaluationCheckpoint | null> {
    let encoded: string;
    try {
      encoded = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const checkpoint = JSON.parse(encoded) as TelemetryEvaluationCheckpoint;
    validateTelemetryCheckpoint(checkpoint);
    if (checkpoint.factoryRunId !== factoryRunId) throw new Error("Telemetry checkpoint belongs to another Factory Run");
    return checkpoint;
  }

  public async save(checkpoint: TelemetryEvaluationCheckpoint): Promise<void> {
    validateTelemetryCheckpoint(checkpoint);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
