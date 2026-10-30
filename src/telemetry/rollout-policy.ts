import type { RolloutGate } from "./contracts.js";

export interface ArmEvidenceFloor {
  readonly minimumUniqueFinishedUsers: number;
  readonly minimumFinishedRequests: number;
}

export interface GatePolicy {
  readonly gate: RolloutGate;
  readonly candidateBasisPoints: number | null;
  readonly minimumDurationMs: number;
  readonly collectionDeadlineMs: number;
  readonly stable: ArmEvidenceFloor | null;
  readonly candidate: ArmEvidenceFloor | null;
}

export const ROLLOUT_LADDER = Object.freeze([
  "staging",
  "stable_reference",
  "gate_5",
  "gate_10",
  "gate_30",
  "gate_50",
  "gate_80",
  "observation"
] as const satisfies readonly RolloutGate[]);

const FLOORS = Object.freeze({
  staging: Object.freeze({
    gate: "staging",
    candidateBasisPoints: null,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: null,
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 })
  }),
  stable_reference: Object.freeze({
    gate: "stable_reference",
    candidateBasisPoints: 0,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: Object.freeze({ minimumUniqueFinishedUsers: 40, minimumFinishedRequests: 80 }),
    candidate: null
  }),
  gate_5: Object.freeze({
    gate: "gate_5",
    candidateBasisPoints: 500,
    minimumDurationMs: 15_000,
    collectionDeadlineMs: 30_000,
    stable: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }),
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 })
  }),
  gate_10: Object.freeze({
    gate: "gate_10",
    candidateBasisPoints: 1_000,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }),
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 })
  }),
  gate_30: Object.freeze({
    gate: "gate_30",
    candidateBasisPoints: 3_000,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: Object.freeze({ minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 }),
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 })
  }),
  gate_50: Object.freeze({
    gate: "gate_50",
    candidateBasisPoints: 5_000,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: Object.freeze({ minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 }),
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 })
  }),
  gate_80: Object.freeze({
    gate: "gate_80",
    candidateBasisPoints: 8_000,
    minimumDurationMs: 15_000,
    collectionDeadlineMs: 30_000,
    stable: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }),
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 })
  }),
  observation: Object.freeze({
    gate: "observation",
    candidateBasisPoints: 10_000,
    minimumDurationMs: 60_000,
    collectionDeadlineMs: 90_000,
    stable: null,
    candidate: Object.freeze({ minimumUniqueFinishedUsers: 100, minimumFinishedRequests: 240 })
  })
} satisfies Readonly<Record<RolloutGate, GatePolicy>>);

export const ROLLOUT_POLICY_V1 = Object.freeze({
  policyId: "rollout-policy/v1" as const,
  syntheticTraffic: Object.freeze({
    logicalRequestsPerSecond: 50,
    maximumInFlight: 8,
    maximumAttemptsPerLogicalRequest: 3,
    perAttemptTimeoutMs: 1_000,
    retryDelaysMs: Object.freeze([50, 100] as const),
    logicalRequestDeadlineMs: 3_000
  }),
  health: Object.freeze({
    probeIntervalMs: 1_000,
    minimumSamplesPerRequiredComponent: 3,
    unhealthyConsecutiveFailures: 3,
    rollbackRestorationConsecutiveHealthy: 2,
    warningMaximumConsecutiveFailures: 2
  }),
  latency: Object.freeze({
    warningAbsoluteIncreaseMs: 20,
    warningRatio: 1.5,
    severeAbsoluteMs: 500,
    severeAbsoluteIncreaseMs: 100,
    severeRatio: 3
  }),
  retry: Object.freeze({
    warningRateIncrease: 0.10,
    warningMinimumExcessEvents: 2,
    severeRate: 0.25,
    severeMinimumEvents: 5
  }),
  incidents: Object.freeze({
    warningWindowsBeforeRollback: 2,
    cleanWindowsToResolveRegression: 2,
    cleanWindowsToResolveRequestFailure: 2,
    cleanWindowsToResolveHealth: 1
  }),
  reevaluationIntervalMs: 5_000,
  gates: FLOORS
});

export function gatePolicy(gate: RolloutGate): GatePolicy {
  return structuredClone(FLOORS[gate]);
}

export function nextRolloutGate(current: RolloutGate, requested?: RolloutGate): RolloutGate | null {
  const index = ROLLOUT_LADDER.indexOf(current);
  const next = ROLLOUT_LADDER[index + 1] ?? null;
  if (requested !== undefined && requested !== next) {
    throw new Error(`rollout ladder cannot skip from ${current} to ${requested}`);
  }
  return next;
}
