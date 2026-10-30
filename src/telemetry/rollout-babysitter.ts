import { canonicalSha256 } from "../protocol/canonical-json.js";
import { AcceptedEventJournal } from "./accepted-event-journal.js";
import {
  BABYSITTER_PROPOSAL_SCHEMA_VERSION,
  sameTelemetryProcessIdentity,
  type ProcessIdentity,
  type RolloutGate,
  type TelemetryPhase
} from "./contracts.js";
import type { TelemetryAssessment } from "./assessment.js";
import type { AcceptedObserverRecord } from "./observer.js";
import { nextRolloutGate } from "./rollout-policy.js";
import type { TelemetryWindowSummary } from "./window-reducer.js";

export type BabysitterProposal =
  | "advance_to_rollout"
  | "advance_exposure"
  | "enter_observation"
  | "hold"
  | "rollback"
  | "pause"
  | "continue_observation"
  | "observation_passed"
  | "stable_confirmed"
  | "incident";

export interface RolloutBabysitterProposal {
  readonly schemaVersion: typeof BABYSITTER_PROPOSAL_SCHEMA_VERSION;
  readonly role: "rollout_babysitter";
  readonly phase: TelemetryPhase;
  readonly currentGate: RolloutGate;
  readonly legalNextGate: RolloutGate | null;
  readonly inputDigest: string;
  readonly factoryRunId: string;
  readonly candidateReleaseId: string;
  readonly routingRevisionId: string;
  readonly windowDigest: string;
  readonly acceptedObserverRecordDigest: string;
  readonly policyId: string;
  readonly proposal: BabysitterProposal;
  readonly reasons: readonly string[];
  readonly proposalDigest: string;
}

const LEGAL_PROPOSALS: Readonly<Record<TelemetryPhase, ReadonlySet<BabysitterProposal>>> = Object.freeze({
  staging: new Set<BabysitterProposal>(["advance_to_rollout", "hold", "rollback", "pause"]),
  stable_reference: new Set<BabysitterProposal>(["advance_exposure", "hold", "pause"]),
  rollout: new Set<BabysitterProposal>(["advance_exposure", "enter_observation", "hold", "rollback", "pause"]),
  observation: new Set<BabysitterProposal>(["continue_observation", "observation_passed", "rollback", "pause"]),
  rollback_confirmation: new Set<BabysitterProposal>(["stable_confirmed", "hold", "incident", "pause"])
});

export function validateProposalForPhase(phase: TelemetryPhase, proposal: BabysitterProposal): void {
  if (!LEGAL_PROPOSALS[phase].has(proposal)) throw new Error(`${proposal} is illegal during ${phase}`);
}

function candidateIncident(record: AcceptedObserverRecord["openIncidents"][number]): boolean {
  return record.conditionId.startsWith("candidate.");
}

export function invokeRolloutBabysitter(input: Readonly<{
  phase: TelemetryPhase;
  summary: TelemetryWindowSummary;
  assessment: TelemetryAssessment;
  acceptedObserverRecord: AcceptedObserverRecord;
}>): RolloutBabysitterProposal {
  const { phase, summary, assessment, acceptedObserverRecord } = input;
  if (acceptedObserverRecord.kind !== "accepted_observer_result") {
    throw new Error("Babysitter requires an Orchestrator-accepted Observer record");
  }
  if (acceptedObserverRecord.windowDigest !== summary.windowDigest) throw new Error("Babysitter window digest mismatch");
  if (acceptedObserverRecord.evidenceState !== assessment.evidenceState) throw new Error("Babysitter assessment mismatch");

  const incidents = acceptedObserverRecord.openIncidents;
  const stableOrControlUnavailable = incidents.some((incident) =>
    incident.conditionId === "stable.rollback_baseline_unavailable"
    || incident.conditionId === "router.control_plane_unhealthy");
  const immediateCandidateSafety = incidents.some((incident) =>
    candidateIncident(incident)
    && incident.lastConditionPresent
    && incident.severity !== "warning");
  const repeatedCandidateWarning = incidents.some((incident) =>
    candidateIncident(incident)
    && incident.lastConditionPresent
    && incident.severity === "warning"
    && incident.conditionWindowCount >= 2);
  let proposal: BabysitterProposal;
  let reasons: readonly string[];

  if (summary.completeness === "stale") {
    proposal = "pause";
    reasons = ["stale_telemetry_binding"];
  } else if (stableOrControlUnavailable) {
    proposal = "pause";
    reasons = ["rollback_baseline_or_control_unavailable"];
  } else if ((immediateCandidateSafety || repeatedCandidateWarning) && summary.binding.candidateBasisPoints > 0) {
    proposal = "rollback";
    reasons = [immediateCandidateSafety ? "candidate_safety_incident" : "repeated_candidate_warning"];
  } else if (summary.completeness === "invalid_conflict") {
    proposal = "pause";
    reasons = ["conflicting_telemetry_evidence"];
  } else if (summary.completeness !== "complete") {
    const deadlineReached = summary.elapsedMs >= summary.binding.collectionDeadlineMs;
    proposal = phase === "observation" || deadlineReached ? "pause" : "hold";
    reasons = [summary.completeness, deadlineReached ? "collection_deadline_reached" : "evidence_incomplete"];
  } else if (phase === "observation" && assessment.reference.state !== "valid") {
    proposal = "pause";
    reasons = ["invalid_pinned_stable_reference"];
  } else if (assessment.sufficiency.state !== "complete_sufficient") {
    const deadlineReached = summary.elapsedMs >= summary.binding.collectionDeadlineMs;
    if (deadlineReached) proposal = "pause";
    else proposal = phase === "observation" ? "continue_observation" : "hold";
    reasons = [assessment.sufficiency.state, deadlineReached ? "collection_deadline_reached" : "bounded_collection_continues"];
  } else if (
    incidents.length > 0
    || assessment.signals.candidateHealth === "degraded"
    || assessment.signals.candidateHealth === "unknown_due_to_gap"
    || assessment.signals.candidateLatency === "regressed"
    || assessment.signals.candidateError === "regressed"
  ) {
    proposal = phase === "observation" ? "continue_observation" : "hold";
    reasons = ["negative_or_unresolved_evidence"];
  } else if (phase === "staging") {
    proposal = "advance_to_rollout";
    reasons = ["complete_sufficient_healthy_staging"];
  } else if (phase === "stable_reference" || phase === "rollout") {
    proposal = "advance_exposure";
    reasons = ["complete_sufficient_healthy_window"];
  } else if (phase === "observation") {
    proposal = "observation_passed";
    reasons = ["complete_observation_passed"];
  } else {
    proposal = "hold";
    reasons = ["rollback_confirmation_requires_restoration_evidence"];
  }

  validateProposalForPhase(phase, proposal);
  const currentGate = summary.binding.gate;
  const legalNextGate = nextRolloutGate(currentGate);
  const inputDigest = canonicalSha256({
    schemaVersion: "rollout-babysitter-input/v1",
    phase,
    currentGate,
    legalNextGate,
    summaryDigest: summary.windowDigest,
    assessmentDigest: assessment.assessmentDigest,
    acceptedObserverRecordDigest: acceptedObserverRecord.acceptedRecordDigest
  });
  const core = {
    schemaVersion: BABYSITTER_PROPOSAL_SCHEMA_VERSION,
    role: "rollout_babysitter" as const,
    phase,
    currentGate,
    legalNextGate,
    inputDigest,
    factoryRunId: summary.factoryRunId,
    candidateReleaseId: summary.binding.candidateReleaseId,
    routingRevisionId: summary.binding.routingRevisionId,
    windowDigest: summary.windowDigest,
    acceptedObserverRecordDigest: acceptedObserverRecord.acceptedRecordDigest,
    policyId: summary.binding.policyId,
    proposal,
    reasons: Object.freeze([...reasons])
  };
  return Object.freeze({ ...core, proposalDigest: canonicalSha256(core) });
}

export interface SafetyInterlock {
  readonly authority: "orchestrator";
  readonly action: "stop_new_synthetic_traffic" | "none";
  readonly reason: "immediate_reversible_safety_interlock" | "not_required";
  readonly lifecycleTransition: null;
}

export function orchestratorSafetyInterlock(summary: TelemetryWindowSummary): SafetyInterlock {
  const candidate = summary.binding.gate === "staging" ? summary.health.staging : summary.health.candidate;
  const unsafe = summary.processExitObserved
    || summary.responseIdentityMismatchObserved
    || candidate?.state === "unhealthy"
    || summary.health.router?.state === "unhealthy";
  return Object.freeze({
    authority: "orchestrator",
    action: unsafe ? "stop_new_synthetic_traffic" : "none",
    reason: unsafe ? "immediate_reversible_safety_interlock" : "not_required",
    lifecycleTransition: null
  });
}

export interface RollbackRestorationProposal {
  readonly schemaVersion: "rollback-restoration-evidence/v1";
  readonly phase: "rollback_confirmation";
  readonly proposal: "stable_confirmed" | "hold" | "pause" | "incident";
  readonly reasons: readonly string[];
  readonly factoryRunId: string;
  readonly stableReleaseId: string;
  readonly stableProcessIdentity: ProcessIdentity;
  readonly routingRevisionId: string;
  readonly rollbackIntentAcceptedEventCursor: number;
  readonly routingReadBackIngestSequence: number | null;
  readonly stableHealthIngestSequences: readonly number[];
  readonly acceptedEventCursor: number;
  readonly journalDigest: string;
  readonly evidenceDigest: string;
}

export function evaluateRollbackRestoration(input: Readonly<{
  journal: AcceptedEventJournal;
  factoryRunId: string;
  stableProcessIdentity: ProcessIdentity;
  routingRevisionId: string;
  rollbackIntentAcceptedEventCursor: number;
}>): RollbackRestorationProposal {
  const events = input.journal.snapshot();
  const routingEvents = events.filter((event) =>
    event.eventType === "routing_revision_applied"
    && event.ingestSequence > input.rollbackIntentAcceptedEventCursor
    && event.factoryRunId === input.factoryRunId
    && event.binding.routingRevisionId === input.routingRevisionId);
  const routing = routingEvents.length === 1 ? routingEvents[0] : undefined;
  const reasons: string[] = [];
  let proposal: RollbackRestorationProposal["proposal"] = "pause";
  let stableHealthSequences: number[] = [];

  if (routing === undefined || routing.eventType !== "routing_revision_applied") {
    reasons.push(routingEvents.length > 1 ? "ambiguous_stable_only_readback" : "stable_only_readback_missing");
  } else {
    const manifestStable = routing.payload.revisionManifest.stable;
    const readBackValid = routing.binding.candidateBasisPoints === 0
      && routing.binding.stableReleaseId === input.stableProcessIdentity.releaseId
      && manifestStable !== undefined
      && sameTelemetryProcessIdentity(manifestStable as ProcessIdentity, input.stableProcessIdentity)
      && routing.payload.observedFingerprint === routing.binding.routingConfigFingerprint;
    if (!readBackValid) {
      reasons.push("stable_only_restoration_unverified");
    } else {
      const later = events.filter((event) => event.ingestSequence > routing.ingestSequence);
      const candidateRequest = later.find((event) => event.eventType === "request_started" && event.payload.selectedArm === "candidate");
      if (candidateRequest !== undefined) {
        proposal = "incident";
        reasons.push("candidate_request_after_stable_only_readback");
      } else {
        const stableHealth = later.filter((event) =>
          event.eventType === "process_health_sampled"
          && sameTelemetryProcessIdentity(event.payload.component, input.stableProcessIdentity));
        const consecutive: number[] = [];
        for (const event of stableHealth) {
          if (event.eventType !== "process_health_sampled") continue;
          if (!event.payload.healthy) consecutive.length = 0;
          else consecutive.push(event.ingestSequence);
          if (consecutive.length === 2) break;
        }
        stableHealthSequences = consecutive;
        if (consecutive.length < 2) {
          proposal = "hold";
          reasons.push("stable_health_confirmation_incomplete");
        } else {
          proposal = "stable_confirmed";
          reasons.push("stable_only_route_and_health_verified");
        }
      }
    }
  }

  validateProposalForPhase("rollback_confirmation", proposal);
  const acceptedEventCursor = events.at(-1)?.ingestSequence ?? 0;
  const core = {
    schemaVersion: "rollback-restoration-evidence/v1" as const,
    phase: "rollback_confirmation" as const,
    proposal,
    reasons: Object.freeze(reasons),
    factoryRunId: input.factoryRunId,
    stableReleaseId: input.stableProcessIdentity.releaseId ?? "",
    stableProcessIdentity: input.stableProcessIdentity,
    routingRevisionId: input.routingRevisionId,
    rollbackIntentAcceptedEventCursor: input.rollbackIntentAcceptedEventCursor,
    routingReadBackIngestSequence: routing?.ingestSequence ?? null,
    stableHealthIngestSequences: Object.freeze(stableHealthSequences),
    acceptedEventCursor,
    journalDigest: input.journal.digest()
  };
  return Object.freeze({ ...core, evidenceDigest: canonicalSha256(core) });
}
