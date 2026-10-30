import type { RoutingRevision } from "./routing-revision.js";

export type ProcessKind =
  | "stable_release"
  | "staging_release"
  | "candidate_release"
  | "router"
  | "synthetic_traffic";
export type DesiredProcessState = "running" | "stopped";
export type ObservedProcessState = "absent" | "starting" | "ready" | "exited" | "stopped";

export interface ProcessAttemptIdentity {
  readonly factoryRunId: string;
  readonly instanceId: string;
  readonly processKind: ProcessKind;
  readonly processAttempt: number;
  readonly releaseId: string | null;
  readonly ownershipNonce: string;
  readonly pid: number;
  readonly processBirthIdentity: string;
}

export interface RuntimeStatus extends ProcessAttemptIdentity {
  readonly protocolVersion: "runtime-status/v1";
  readonly port: number;
  readonly lifecycleState: "ready" | "draining";
  readonly details: Readonly<Record<string, unknown>>;
}

export interface RuntimeDescriptor extends RuntimeStatus {
  readonly schemaVersion: "1.0";
  readonly contract: "runtime_descriptor";
  readonly endpoint: string;
  readonly readyAt: string;
}

export interface ProcessIntent {
  readonly kind: "spawn" | "restart" | "stop";
  readonly intentId: string;
  readonly recordedAt: string;
}

export interface ProcessAttemptRecord {
  readonly factoryRunId: string;
  readonly instanceId: string;
  readonly processKind: ProcessKind;
  readonly processAttempt: number;
  readonly releaseId: string | null;
  readonly commandDigest: string;
  readonly desiredState: DesiredProcessState;
  readonly observedState: ObservedProcessState;
  readonly pid: number | null;
  readonly processGroupId: number | null;
  readonly processBirthIdentity: string | null;
  readonly ownershipNonce: string;
  readonly endpoint: string | null;
  readonly runtimeDescriptorPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly dataDirectory: string;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly exitedAt: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly expectedExit: boolean;
  readonly intent: ProcessIntent | null;
}

export interface ProcessRegistry {
  readonly schemaVersion: "1.0";
  readonly contract: "runtime_process_registry";
  readonly factoryRunId: string;
  readonly startupOrder: readonly string[];
  readonly instances: readonly ProcessAttemptRecord[];
  readonly desiredRouting: RoutingRevision | null;
  readonly routing: RoutingRevision | null;
  readonly updatedAt: string;
}

export interface TopologySnapshot {
  readonly factoryRunId: string;
  readonly startupOrder: readonly string[];
  readonly instances: readonly ProcessAttemptRecord[];
  readonly desiredRouting: RoutingRevision | null;
  readonly routing: RoutingRevision | null;
}

export interface TopologyPlan {
  readonly factoryRunId: string;
  readonly runDirectory: string;
  readonly stableReleaseId: string;
  readonly candidateReleaseId: string;
  readonly rolloutSeed: string;
  readonly ignoreSigtermProcessKinds?: readonly ProcessKind[];
}

export interface TopologyOptions {
  readonly startupDeadlineMs?: number;
  readonly probeIntervalMs?: number;
  readonly livenessIntervalMs?: number;
  readonly stopGraceMs?: number;
  readonly childEntrypoint?: string;
}

export interface CleanupResult {
  readonly escalatedInstanceIds: readonly string[];
  readonly stoppedInstanceIds: readonly string[];
}

export interface LivenessResponse {
  readonly instanceId: string;
  readonly processKind: ProcessKind;
  readonly action: "stable_only_verified" | "traffic_paused" | "evidence_interrupted";
}
