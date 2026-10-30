import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  OBSERVER_ASSESSMENT_SCHEMA_VERSION,
  sameTelemetryProcessIdentity,
  type ComponentName,
  type ProcessIdentity
} from "./contracts.js";
import type { AcceptedObserverRecord } from "./observer.js";
import {
  conditionPolicy,
  validateConditionSeverity,
  type ConditionId,
  type IncidentSeverity
} from "./condition-policy.js";
import { ROLLOUT_POLICY_V1 } from "./rollout-policy.js";
import {
  evaluateSufficiency,
  type ArmMetrics,
  type ComponentHealthState,
  type SufficiencyAssessment,
  type TelemetryWindowSummary
} from "./window-reducer.js";

export type SignalState =
  | ComponentHealthState
  | "healthy"
  | "regressed"
  | "breached"
  | "insufficient_evidence"
  | "unknown_due_to_gap"
  | "not_applicable";

export interface ObservedCondition {
  readonly conditionId: ConditionId;
  readonly severity: IncidentSeverity;
  readonly affected: Readonly<Record<string, unknown>>;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly cleanWindowsToResolve: number;
  readonly deduplicationKey: string;
}

export interface StableReference {
  readonly schemaVersion: "stable-reference/v1";
  readonly windowId: string;
  readonly windowDigest: string;
  readonly windowBindingDigest: string;
  readonly acceptedEventDigest: string;
  readonly assessmentDigest: string;
  readonly acceptedObserverRecordDigest: string;
  readonly stableReleaseId: string;
  readonly stableIdentity: ProcessIdentity;
  readonly workloadId: string;
  readonly workloadDigest: string;
  readonly policyId: string;
  readonly metrics: ArmMetrics;
  readonly referenceDigest: string;
}

export interface StableReferenceAssessment {
  readonly state: "not_required" | "valid" | "invalid";
  readonly reasons: readonly string[];
}

export interface TelemetryAssessment {
  readonly schemaVersion: typeof OBSERVER_ASSESSMENT_SCHEMA_VERSION;
  readonly windowId: string;
  readonly windowDigest: string;
  readonly evidenceState: string;
  readonly completeness: TelemetryWindowSummary["completeness"];
  readonly sufficiency: SufficiencyAssessment;
  readonly reference: StableReferenceAssessment;
  readonly signals: Readonly<{
    stableHealth: SignalState;
    candidateHealth: SignalState;
    routerHealth: SignalState;
    syntheticTrafficHealth: SignalState;
    stableError: SignalState;
    candidateError: SignalState;
    candidateLatency: SignalState;
  }>;
  readonly violatedConditions: readonly string[];
  readonly conditions: readonly ObservedCondition[];
  readonly assessmentDigest: string;
}


function componentHealth(summary: TelemetryWindowSummary, component: ComponentName): ComponentHealthState {
  return summary.health[component]?.state ?? "unknown_due_to_gap";
}

function condition(
  summary: TelemetryWindowSummary,
  conditionId: ConditionId,
  severity: IncidentSeverity,
  affected: Readonly<Record<string, unknown>>,
  evidence: Readonly<Record<string, unknown>>
): ObservedCondition {
  validateConditionSeverity(conditionId, severity);
  return Object.freeze({
    conditionId,
    severity,
    affected: Object.freeze(structuredClone(affected)),
    evidence: Object.freeze(structuredClone(evidence)),
    cleanWindowsToResolve: conditionPolicy(conditionId).cleanWindowsToResolve,
    deduplicationKey: canonicalSha256({
      policyId: summary.binding.policyId,
      factoryRunId: summary.factoryRunId,
      conditionId,
      affected
    })
  });
}

export function createStableReference(input: Readonly<{
  summary: TelemetryWindowSummary;
  assessment: TelemetryAssessment;
  acceptedObserverRecord: AcceptedObserverRecord;
}>): StableReference {
  const { summary, assessment, acceptedObserverRecord } = input;
  const stable = summary.binding.components.stable;
  if (summary.binding.gate !== "stable_reference") throw new TypeError("Stable reference requires the stable_reference gate");
  if (summary.completeness !== "complete" || assessment.sufficiency.state !== "complete_sufficient") {
    throw new TypeError("Stable reference must be complete and sufficient");
  }
  if (stable === undefined || summary.health.stable?.state !== "healthy") {
    throw new TypeError("Stable reference requires a healthy exact Stable Process Attempt");
  }
  if (assessment.windowDigest !== summary.windowDigest || acceptedObserverRecord.windowDigest !== summary.windowDigest) {
    throw new TypeError("Stable reference assessment is bound to a different source window");
  }
  if (acceptedObserverRecord.assessmentDigest !== assessment.assessmentDigest) {
    throw new TypeError("Stable reference assessment digest was not accepted");
  }
  if (assessment.conditions.length !== 0 || acceptedObserverRecord.openIncidents.length !== 0) {
    throw new TypeError("Stable reference requires clean accepted evidence without Incidents");
  }
  const core = {
    schemaVersion: "stable-reference/v1" as const,
    windowId: summary.windowId,
    windowDigest: summary.windowDigest,
    windowBindingDigest: summary.binding.bindingDigest,
    acceptedEventDigest: summary.acceptedEventDigest,
    assessmentDigest: assessment.assessmentDigest,
    acceptedObserverRecordDigest: acceptedObserverRecord.acceptedRecordDigest,
    stableReleaseId: summary.binding.stableReleaseId,
    stableIdentity: stable,
    workloadId: summary.binding.workloadId,
    workloadDigest: summary.binding.workloadDigest,
    policyId: summary.binding.policyId,
    metrics: summary.metrics.stable
  };
  return Object.freeze({ ...core, referenceDigest: canonicalSha256(core) });
}

export interface StableReferenceSourceEvidence {
  readonly summary: TelemetryWindowSummary;
  readonly assessment: TelemetryAssessment;
}

export function validateStableReference(
  summary: TelemetryWindowSummary,
  reference: StableReference | null,
  sourceEvidence: StableReferenceSourceEvidence | null = null
): StableReferenceAssessment {
  if (summary.binding.candidateBasisPoints !== 10_000) return Object.freeze({ state: "not_required", reasons: [] });
  if (reference === null) return Object.freeze({ state: "invalid", reasons: ["missing_pinned_stable_reference"] });
  const reasons: string[] = [];
  const { referenceDigest: _digest, ...referenceCore } = reference;
  if (canonicalSha256(referenceCore) !== reference.referenceDigest) reasons.push("reference_digest_mismatch");
  if (summary.binding.pinnedStableReferenceWindowId !== reference.windowId) reasons.push("wrong_window");
  if (summary.binding.stableReleaseId !== reference.stableReleaseId) reasons.push("stable_release_changed");
  const activeStable = summary.binding.components.stable;
  if (activeStable === undefined || !sameTelemetryProcessIdentity(activeStable, reference.stableIdentity)) reasons.push("stable_process_attempt_changed");
  if (summary.binding.workloadId !== reference.workloadId || summary.binding.workloadDigest !== reference.workloadDigest) reasons.push("workload_changed");
  if (summary.binding.policyId !== reference.policyId) reasons.push("policy_changed");
  if (sourceEvidence === null) {
    reasons.push("source_window_not_reduced");
  } else {
    const source = sourceEvidence.summary;
    const sourceAssessment = sourceEvidence.assessment;
    if (source.windowId !== reference.windowId) reasons.push("source_window_id_mismatch");
    if (source.windowDigest !== reference.windowDigest) reasons.push("source_window_digest_mismatch");
    if (source.binding.bindingDigest !== reference.windowBindingDigest) reasons.push("source_binding_digest_mismatch");
    if (source.acceptedEventDigest !== reference.acceptedEventDigest) reasons.push("source_event_digest_mismatch");
    if (sourceAssessment.assessmentDigest !== reference.assessmentDigest) reasons.push("source_assessment_digest_mismatch");
    if (source.completeness !== "complete" || sourceAssessment.sufficiency.state !== "complete_sufficient" || sourceAssessment.conditions.length !== 0) {
      reasons.push("source_window_not_clean");
    }
    if (canonicalSha256(source.metrics.stable) !== canonicalSha256(reference.metrics)) reasons.push("source_metrics_mismatch");
    const sourceStable = source.binding.components.stable;
    if (sourceStable === undefined || !sameTelemetryProcessIdentity(sourceStable, reference.stableIdentity)) reasons.push("source_stable_identity_mismatch");
  }
  return Object.freeze({ state: reasons.length === 0 ? "valid" : "invalid", reasons: Object.freeze([...new Set(reasons)]) });
}

function comparableReference(
  summary: TelemetryWindowSummary,
  stableReference: StableReference | null,
  reference: StableReferenceAssessment,
  sufficiency: SufficiencyAssessment
): Readonly<{ metrics: ArmMetrics; windowId: string }> | null {
  if (summary.completeness !== "complete" || sufficiency.state !== "complete_sufficient") return null;
  if (summary.binding.candidateBasisPoints > 0 && summary.binding.candidateBasisPoints < 10_000) {
    return Object.freeze({ metrics: summary.metrics.stable, windowId: summary.windowId });
  }
  if (summary.binding.candidateBasisPoints === 10_000 && reference.state === "valid" && stableReference !== null) {
    return Object.freeze({ metrics: stableReference.metrics, windowId: stableReference.windowId });
  }
  return null;
}

function referenceIsHealthy(summary: TelemetryWindowSummary): boolean {
  return componentHealth(summary, "stable") === "healthy"
    && componentHealth(summary, "router") === "healthy"
    && componentHealth(summary, "traffic") === "healthy";
}

export function assessTelemetryWindow(
  summary: TelemetryWindowSummary,
  stableReference: StableReference | null = null,
  stableReferenceSource: StableReferenceSourceEvidence | null = null
): TelemetryAssessment {
  const sufficiency = evaluateSufficiency(summary);
  const reference = validateStableReference(summary, stableReference, stableReferenceSource);
  const candidateComponent = summary.binding.gate === "staging" ? "staging" : "candidate";
  const stableHealth = componentHealth(summary, "stable");
  const candidateHealth = componentHealth(summary, candidateComponent);
  const routerHealth = componentHealth(summary, "router");
  const trafficHealth = componentHealth(summary, "traffic");
  const stable = summary.metrics.stable;
  const candidate = summary.metrics.candidate;
  const conditions: ObservedCondition[] = [];
  const violated = new Set<string>();
  let stableError: SignalState = stable.logicalRequestsFinished > 0 ? "healthy" : "not_applicable";
  let candidateError: SignalState = candidate.logicalRequestsFinished > 0 ? "healthy" : "not_applicable";
  let candidateLatency: SignalState = candidate.latencyP95Ms === null ? "not_applicable" : "insufficient_evidence";

  const add = (value: ObservedCondition): void => {
    if (!violated.has(value.conditionId)) conditions.push(value);
    violated.add(value.conditionId);
  };

  if (stableHealth === "unhealthy" || stableHealth === "degraded" || stable.finalFailures > 0) {
    if (stable.finalFailures > 0) stableError = "breached";
    add(condition(
      summary,
      "stable.rollback_baseline_unavailable",
      stableHealth === "unhealthy" || stable.finalFailures > 0 ? "critical" : "high",
      { scope: "release", slot: "stable", releaseId: summary.binding.stableReleaseId },
      { health: summary.health.stable ?? null, finalFailures: stable.finalFailures }
    ));
  }
  if (routerHealth === "unhealthy" || routerHealth === "degraded") {
    add(condition(
      summary,
      "router.control_plane_unhealthy",
      "critical",
      { scope: "component", component: "router" },
      { health: summary.health.router ?? null }
    ));
  }
  if (trafficHealth === "unhealthy" || trafficHealth === "degraded") {
    add(condition(
      summary,
      "traffic.synthetic_traffic_unhealthy",
      "high",
      { scope: "component", component: "traffic" },
      { health: summary.health.traffic ?? null }
    ));
  }
  if (candidateHealth === "unhealthy" || candidateHealth === "degraded") {
    add(condition(
      summary,
      "candidate.process_unhealthy",
      candidateHealth === "unhealthy" ? "critical" : "warning",
      { scope: "release", slot: "candidate", releaseId: summary.binding.candidateReleaseId },
      { health: summary.health[candidateComponent] ?? null, exposureBasisPoints: summary.binding.candidateBasisPoints }
    ));
  }

  if (candidate.finalFailures > 0 || candidate.protocolFaults > 0 || summary.responseIdentityMismatchObserved) {
    candidateError = "breached";
    add(condition(
      summary,
      "candidate.request_failure",
      candidate.protocolFaults > 0 || summary.responseIdentityMismatchObserved ? "critical" : "high",
      { scope: "release", slot: "candidate", releaseId: summary.binding.candidateReleaseId },
      {
        finalFailures: candidate.finalFailures,
        protocolFaults: candidate.protocolFaults,
        responseIdentityMismatchObserved: summary.responseIdentityMismatchObserved
      }
    ));
  }

  if (summary.completeness === "incomplete_gap" || summary.completeness === "invalid_conflict") {
    add(condition(
      summary,
      "telemetry.monitoring_gap",
      summary.completeness === "invalid_conflict" ? "critical" : "high",
      { scope: "telemetry", windowId: summary.windowId },
      { completeness: summary.completeness, reasons: summary.completenessReasons }
    ));
  }

  const comparison = comparableReference(summary, stableReference, reference, sufficiency);
  const canCompare = comparison !== null && referenceIsHealthy(summary);
  if (candidateError !== "breached") {
    if (canCompare) {
      const candidateRetryRate = candidate.retryRate ?? 0;
      const referenceRetryRate = comparison.metrics.retryRate ?? 0;
      const candidateAttemptRate = candidate.nonSuccessAttemptRate ?? 0;
      const referenceAttemptRate = comparison.metrics.nonSuccessAttemptRate ?? 0;
      const excessRetryEvents = candidate.retries - Math.floor(referenceRetryRate * candidate.logicalRequestsFinished);
      const excessAttemptEvents = (candidate.attempts - candidate.successes) - Math.floor(referenceAttemptRate * candidate.attempts);
      const severe = (candidateRetryRate >= ROLLOUT_POLICY_V1.retry.severeRate && candidate.retries >= ROLLOUT_POLICY_V1.retry.severeMinimumEvents)
        || (candidateAttemptRate >= ROLLOUT_POLICY_V1.retry.severeRate && candidate.attempts - candidate.successes >= ROLLOUT_POLICY_V1.retry.severeMinimumEvents);
      const warning = (candidateRetryRate - referenceRetryRate > ROLLOUT_POLICY_V1.retry.warningRateIncrease && excessRetryEvents >= ROLLOUT_POLICY_V1.retry.warningMinimumExcessEvents)
        || (candidateAttemptRate - referenceAttemptRate > ROLLOUT_POLICY_V1.retry.warningRateIncrease && excessAttemptEvents >= ROLLOUT_POLICY_V1.retry.warningMinimumExcessEvents);
      if (severe || warning) {
        candidateError = severe ? "breached" : "regressed";
        add(condition(
          summary,
          "candidate.error_regression",
          severe ? "high" : "warning",
          { scope: "release", slot: "candidate", releaseId: summary.binding.candidateReleaseId },
          {
            candidateRetryRate,
            referenceRetryRate,
            candidateNonSuccessAttemptRate: candidateAttemptRate,
            referenceNonSuccessAttemptRate: referenceAttemptRate,
            referenceWindowId: comparison.windowId
          }
    ));
      } else {
        candidateError = "healthy";
      }
    } else if (summary.completeness !== "complete") {
      candidateError = "unknown_due_to_gap";
    } else if (candidate.logicalRequestsFinished > 0) {
      candidateError = "insufficient_evidence";
    }
  }

  if (candidate.latencyP95Ms !== null) {
    const referenceP95 = comparison?.metrics.latencyP95Ms ?? null;
    const severeRelativeThreshold = referenceP95 === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
        referenceP95 + ROLLOUT_POLICY_V1.latency.severeAbsoluteIncreaseMs,
        referenceP95 * ROLLOUT_POLICY_V1.latency.severeRatio
      );
    const severe = candidate.latencyP95Ms > ROLLOUT_POLICY_V1.latency.severeAbsoluteMs
      || candidate.latencyP95Ms > severeRelativeThreshold;
    if (severe) {
      candidateLatency = "breached";
      add(condition(
        summary,
        "candidate.latency_regression",
        "high",
        { scope: "release", slot: "candidate", releaseId: summary.binding.candidateReleaseId },
        {
          candidateP95Ms: candidate.latencyP95Ms,
          referenceP95Ms: referenceP95,
          absoluteLimitMs: ROLLOUT_POLICY_V1.latency.severeAbsoluteMs,
          relativeSevereThresholdMs: Number.isFinite(severeRelativeThreshold) ? severeRelativeThreshold : null
        }
    ));
    } else if (canCompare && referenceP95 !== null) {
      const warningThreshold = Math.max(
        referenceP95 + ROLLOUT_POLICY_V1.latency.warningAbsoluteIncreaseMs,
        referenceP95 * ROLLOUT_POLICY_V1.latency.warningRatio
      );
      if (candidate.latencyP95Ms > warningThreshold) {
        candidateLatency = "regressed";
        add(condition(
          summary,
          "candidate.latency_regression",
          "warning",
          { scope: "release", slot: "candidate", releaseId: summary.binding.candidateReleaseId },
          {
            candidateP95Ms: candidate.latencyP95Ms,
            referenceP95Ms: referenceP95,
            thresholdMs: warningThreshold,
            referenceWindowId: comparison.windowId
          }
    ));
      } else {
        candidateLatency = "healthy";
      }
    } else if (summary.completeness !== "complete") {
      candidateLatency = "unknown_due_to_gap";
    }
  }

  conditions.sort((left, right) => conditionPolicy(left.conditionId).order - conditionPolicy(right.conditionId).order);
  const evidenceState = summary.completeness === "complete"
    ? sufficiency.state
    : summary.completeness;
  const core = {
    schemaVersion: OBSERVER_ASSESSMENT_SCHEMA_VERSION,
    windowId: summary.windowId,
    windowDigest: summary.windowDigest,
    evidenceState,
    completeness: summary.completeness,
    sufficiency,
    reference,
    signals: Object.freeze({
      stableHealth,
      candidateHealth,
      routerHealth,
      syntheticTrafficHealth: trafficHealth,
      stableError,
      candidateError,
      candidateLatency
    }),
    violatedConditions: Object.freeze([...violated]),
    conditions: Object.freeze(conditions)
  } as const;
  return Object.freeze({ ...core, assessmentDigest: canonicalSha256(core) });
}

export function conditionCanClear(conditionId: ObservedCondition["conditionId"], assessment: TelemetryAssessment): boolean {
  if (assessment.completeness !== "complete") return false;
  if (conditionId === "candidate.latency_regression") return assessment.signals.candidateLatency === "healthy";
  if (conditionId === "candidate.error_regression" || conditionId === "candidate.request_failure") return assessment.signals.candidateError === "healthy";
  if (conditionId === "candidate.process_unhealthy") return assessment.signals.candidateHealth === "healthy";
  if (conditionId === "stable.rollback_baseline_unavailable") return assessment.signals.stableHealth === "healthy" && assessment.signals.stableError !== "breached";
  if (conditionId === "router.control_plane_unhealthy") return assessment.signals.routerHealth === "healthy";
  if (conditionId === "traffic.synthetic_traffic_unhealthy") return assessment.signals.syntheticTrafficHealth === "healthy";
  return assessment.completeness === "complete";
}
