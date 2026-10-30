export type IncidentSeverity = "warning" | "high" | "critical";
export type ConditionAction = "hold" | "rollback" | "pause";

export type ConditionId =
  | "stable.rollback_baseline_unavailable"
  | "router.control_plane_unhealthy"
  | "traffic.synthetic_traffic_unhealthy"
  | "candidate.process_unhealthy"
  | "candidate.request_failure"
  | "candidate.error_regression"
  | "candidate.latency_regression"
  | "telemetry.monitoring_gap";

export interface ConditionPolicy {
  readonly conditionId: ConditionId;
  readonly order: number;
  readonly defaultSeverity: IncidentSeverity;
  readonly allowedSeverities: readonly IncidentSeverity[];
  readonly cleanWindowsToResolve: number;
  readonly action: ConditionAction;
}

export const CONDITION_POLICY_REGISTRY: Readonly<Record<ConditionId, ConditionPolicy>> = Object.freeze({
  "stable.rollback_baseline_unavailable": Object.freeze({ conditionId: "stable.rollback_baseline_unavailable", order: 0, defaultSeverity: "critical", allowedSeverities: Object.freeze(["high", "critical"] as const), cleanWindowsToResolve: 1, action: "pause" }),
  "router.control_plane_unhealthy": Object.freeze({ conditionId: "router.control_plane_unhealthy", order: 1, defaultSeverity: "critical", allowedSeverities: Object.freeze(["critical"] as const), cleanWindowsToResolve: 1, action: "pause" }),
  "traffic.synthetic_traffic_unhealthy": Object.freeze({ conditionId: "traffic.synthetic_traffic_unhealthy", order: 2, defaultSeverity: "high", allowedSeverities: Object.freeze(["high"] as const), cleanWindowsToResolve: 1, action: "pause" }),
  "candidate.process_unhealthy": Object.freeze({ conditionId: "candidate.process_unhealthy", order: 3, defaultSeverity: "critical", allowedSeverities: Object.freeze(["warning", "critical"] as const), cleanWindowsToResolve: 1, action: "rollback" }),
  "candidate.request_failure": Object.freeze({ conditionId: "candidate.request_failure", order: 4, defaultSeverity: "high", allowedSeverities: Object.freeze(["high", "critical"] as const), cleanWindowsToResolve: 2, action: "rollback" }),
  "candidate.error_regression": Object.freeze({ conditionId: "candidate.error_regression", order: 5, defaultSeverity: "warning", allowedSeverities: Object.freeze(["warning", "high"] as const), cleanWindowsToResolve: 2, action: "hold" }),
  "candidate.latency_regression": Object.freeze({ conditionId: "candidate.latency_regression", order: 6, defaultSeverity: "warning", allowedSeverities: Object.freeze(["warning", "high"] as const), cleanWindowsToResolve: 2, action: "hold" }),
  "telemetry.monitoring_gap": Object.freeze({ conditionId: "telemetry.monitoring_gap", order: 7, defaultSeverity: "high", allowedSeverities: Object.freeze(["high", "critical"] as const), cleanWindowsToResolve: 1, action: "pause" })
});

export function conditionPolicy(conditionId: ConditionId): ConditionPolicy {
  return CONDITION_POLICY_REGISTRY[conditionId];
}

export function validateConditionSeverity(conditionId: ConditionId, severity: IncidentSeverity): void {
  if (!conditionPolicy(conditionId).allowedSeverities.includes(severity)) {
    throw new Error(`${severity} is not allowed for ${conditionId}`);
  }
}
