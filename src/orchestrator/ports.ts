import type { ObservationEvidence } from "../domain/factory-run.js";
import type { WorkerResult } from "../protocol/contracts.js";
import type { GitHubControl, SourceControl } from "../control/ports.js";
import type { RoleRuntime } from "../roles/port.js";
import type { ReleaseTopology } from "../runtime/port.js";
import type { TelemetryEngine } from "../telemetry/port.js";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: "az" | "evt" | "fe" | "fx" | "fr"): string;
}

export interface OrchestratorAdapters {
  readonly githubControl: GitHubControl;
  readonly sourceControl: SourceControl;
  readonly roleRuntime: RoleRuntime;
  readonly releaseTopology: ReleaseTopology;
  readonly telemetryEngine: TelemetryEngine;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export function observationEvidenceFrom(result: WorkerResult): ObservationEvidence {
  return {
    candidateHeadSha: result.candidateHeadSha,
    windowComplete: result.facts.observationComplete === true,
    telemetryPassed: result.facts.telemetryPassed === true,
    unresolvedIncidentCount: result.facts.unresolvedIncidentCount ?? -1,
    evidenceDigest: result.inputSha256
  };
}
