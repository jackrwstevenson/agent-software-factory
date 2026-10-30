import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { RolloutGate, TelemetryPhase } from "./contracts.js";
import {
  invokeObserver,
  type AcceptedObserverRecord,
  type ObserverInput,
  type ObserverResult
} from "./observer.js";
import {
  invokeRolloutBabysitter,
  validateProposalForPhase,
  type RolloutBabysitterProposal
} from "./rollout-babysitter.js";
import type { TelemetryAssessment } from "./assessment.js";
import type { TelemetryWindowSummary } from "./window-reducer.js";
import { nextRolloutGate } from "./rollout-policy.js";

export interface BabysitterWorkerInput {
  readonly schemaVersion: "rollout-babysitter-input/v1";
  readonly phase: TelemetryPhase;
  readonly currentGate: RolloutGate;
  readonly legalNextGate: RolloutGate | null;
  readonly summary: TelemetryWindowSummary;
  readonly assessment: TelemetryAssessment;
  readonly acceptedObserverRecord: AcceptedObserverRecord;
  readonly inputDigest: string;
}

function digestInput(value: Readonly<Record<string, unknown>>): string {
  return canonicalSha256(value);
}

export function validateObserverWorkerInput(input: ObserverInput): void {
  const { inputDigest, ...core } = input;
  if (digestInput(core) !== inputDigest) throw new Error("Observer worker input digest mismatch");
}

export function buildBabysitterWorkerInput(input: Readonly<{
  summary: TelemetryWindowSummary;
  assessment: TelemetryAssessment;
  acceptedObserverRecord: AcceptedObserverRecord;
}>): BabysitterWorkerInput {
  const phase = input.summary.binding.phase;
  const currentGate = input.summary.binding.gate;
  const legalNextGate = nextRolloutGate(currentGate);
  const core = {
    schemaVersion: "rollout-babysitter-input/v1" as const,
    phase,
    currentGate,
    legalNextGate,
    summary: input.summary,
    assessment: input.assessment,
    acceptedObserverRecord: input.acceptedObserverRecord
  };
  return Object.freeze({ ...core, inputDigest: canonicalSha256({
    schemaVersion: core.schemaVersion,
    phase,
    currentGate,
    legalNextGate,
    summaryDigest: input.summary.windowDigest,
    assessmentDigest: input.assessment.assessmentDigest,
    acceptedObserverRecordDigest: input.acceptedObserverRecord.acceptedRecordDigest
  }) });
}

export function validateBabysitterWorkerInput(input: BabysitterWorkerInput): void {
  if (input.phase !== input.summary.binding.phase) throw new Error("Babysitter phase mismatch");
  if (input.currentGate !== input.summary.binding.gate) throw new Error("Babysitter gate mismatch");
  if (input.legalNextGate !== nextRolloutGate(input.currentGate)) throw new Error("Babysitter legal next gate mismatch");
  const expected = buildBabysitterWorkerInput(input);
  if (expected.inputDigest !== input.inputDigest) throw new Error("Babysitter worker input digest mismatch");
  if (input.acceptedObserverRecord.windowDigest !== input.summary.windowDigest) throw new Error("Babysitter Observer binding mismatch");
}

export function invokeObserverWorker(input: ObserverInput): ObserverResult {
  validateObserverWorkerInput(input);
  return invokeObserver(input, `observer-subprocess-${process.pid}`);
}

export function invokeBabysitterWorker(input: BabysitterWorkerInput): RolloutBabysitterProposal {
  validateBabysitterWorkerInput(input);
  const result = invokeRolloutBabysitter({
    phase: input.phase,
    summary: input.summary,
    assessment: input.assessment,
    acceptedObserverRecord: input.acceptedObserverRecord
  });
  if (result.inputDigest !== input.inputDigest) throw new Error("Babysitter result input digest mismatch");
  return result;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} schema keys mismatch`);
}

export function acceptObserverWorkerOutput(input: ObserverInput, output: unknown): ObserverResult {
  if (output === null || typeof output !== "object" || Array.isArray(output)) throw new Error("Observer worker output must be an object");
  exactKeys(output, [
    "schemaVersion", "role", "invocationId", "observerSessionId", "sampleSequence",
    "acceptedEventCursor", "factoryRunId", "candidateReleaseId", "routingRevisionId",
    "windowId", "windowDigest", "inputDigest", "evidenceState", "assessmentDigest",
    "facts", "incidentTransitions", "semanticResultDigest", "resultDigest"
  ], "Observer worker output");
  const result = output as ObserverResult;
  const { resultDigest, ...core } = result;
  if (canonicalSha256(core) !== resultDigest) throw new Error("Observer worker result digest mismatch");
  if (result.inputDigest !== input.inputDigest || result.assessmentDigest !== input.assessment.assessmentDigest) {
    throw new Error("Observer worker output binding mismatch");
  }
  return result;
}

export function acceptBabysitterWorkerOutput(
  input: BabysitterWorkerInput,
  output: unknown
): RolloutBabysitterProposal {
  if (output === null || typeof output !== "object" || Array.isArray(output)) throw new Error("Babysitter worker output must be an object");
  exactKeys(output, [
    "schemaVersion", "role", "phase", "currentGate", "legalNextGate", "inputDigest",
    "factoryRunId", "candidateReleaseId", "routingRevisionId", "windowDigest",
    "acceptedObserverRecordDigest", "policyId", "proposal", "reasons", "proposalDigest"
  ], "Babysitter worker output");
  const result = output as RolloutBabysitterProposal;
  const { proposalDigest, ...core } = result;
  if (canonicalSha256(core) !== proposalDigest) throw new Error("Babysitter proposal digest mismatch");
  if (result.inputDigest !== input.inputDigest || result.phase !== input.phase || result.currentGate !== input.currentGate) {
    throw new Error("Babysitter worker output binding mismatch");
  }
  if (result.legalNextGate !== input.legalNextGate) throw new Error("Babysitter worker skipped the legal next gate");
  validateProposalForPhase(result.phase, result.proposal);
  const expected = invokeBabysitterWorker(input);
  if (expected.proposalDigest !== result.proposalDigest) throw new Error("Babysitter worker semantic result mismatch");
  return result;
}
