import type { RolloutEvidence } from "../domain/factory-run.js";
import {
  parseDigest,
  type CandidateRelease,
  type EffectInvocationContext,
  type WorkerResult
} from "../protocol/contracts.js";
import { AcceptedEventJournal } from "./accepted-event-journal.js";
import type { StableReference } from "./assessment.js";
import {
  sealTelemetryCheckpoint,
  type TelemetryCheckpointStore
} from "./checkpoint-store.js";
import { IncidentStore } from "./incidents.js";
import { ObserverSession } from "./observer.js";
import { processTelemetryWindowWithWorkers } from "./pipeline.js";
import type { TelemetryEngine } from "./port.js";
import type { BabysitterProposal } from "./rollout-babysitter.js";
import { ShortLivedTelemetryWorkers } from "./subprocess-workers.js";
import type { ReduceWindowOptions } from "./window-reducer.js";

export interface TelemetryEvidence {
  readonly journal: AcceptedEventJournal;
  readonly windowId: string;
  readonly checkpointStore: TelemetryCheckpointStore;
  readonly pinnedStableReference?: StableReference | null;
  readonly reduceOptions?: ReduceWindowOptions;
}

export interface TelemetryEvidenceProvider {
  loadRolloutEvidence(input: Readonly<{
    context: EffectInvocationContext;
    candidate: CandidateRelease;
    rollout: RolloutEvidence;
  }>): Promise<TelemetryEvidence>;
  loadObservationEvidence(input: Readonly<{
    context: EffectInvocationContext;
    candidate: CandidateRelease;
  }>): Promise<TelemetryEvidence>;
}

function workerDecision(proposal: BabysitterProposal): WorkerResult["decision"] {
  if (proposal === "incident") throw new Error("incident is not a TelemetryEngine terminal worker decision");
  return proposal;
}

export class JournalTelemetryEngine implements TelemetryEngine {
  readonly #workers: ShortLivedTelemetryWorkers;

  public constructor(
    readonly evidenceProvider: TelemetryEvidenceProvider,
    workers = new ShortLivedTelemetryWorkers()
  ) {
    this.#workers = workers;
  }

  async #evaluate(
    evidence: TelemetryEvidence,
    context: EffectInvocationContext,
    candidate: CandidateRelease
  ): Promise<WorkerResult> {
    const prior = await evidence.checkpointStore.load(context.factoryRunId);
    const incidents = prior === null ? new IncidentStore() : IncidentStore.replay(prior.incidents);
    const observer = prior === null
      ? new ObserverSession(`observer-${context.factoryRunId}`)
      : ObserverSession.replay(prior.observer);
    const processed = await processTelemetryWindowWithWorkers({
      journal: evidence.journal,
      windowId: evidence.windowId,
      incidents,
      observer,
      workers: this.#workers,
      ...(evidence.pinnedStableReference === undefined ? {} : { pinnedStableReference: evidence.pinnedStableReference }),
      ...(evidence.reduceOptions === undefined ? {} : { reduceOptions: evidence.reduceOptions })
    });
    if (processed.summary.factoryRunId !== context.factoryRunId) throw new Error("Telemetry evidence is bound to a different Factory Run");
    if (processed.summary.binding.candidateReleaseId !== candidate.headCommitSha) throw new Error("Telemetry evidence is bound to a stale Candidate Release");

    const checkpoint = sealTelemetryCheckpoint({
      factoryRunId: context.factoryRunId,
      evaluationSequence: (prior?.evaluationSequence ?? 0) + 1,
      journal: evidence.journal.checkpoint(),
      incidents: incidents.snapshot(),
      observer: observer.snapshot(),
      observerInput: processed.observerInput,
      observerResult: processed.observerResult,
      acceptedObserverRecord: processed.accepted,
      babysitterInput: processed.babysitterInput,
      babysitterResult: processed.proposal,
      observerWorkerPid: processed.observerWorker.pid,
      babysitterWorkerPid: processed.babysitterWorker.pid
    });
    await evidence.checkpointStore.save(checkpoint);

    const decision = workerDecision(processed.proposal.proposal);
    const telemetryPassed = decision === "advance_to_rollout"
      || decision === "advance_exposure"
      || decision === "enter_observation"
      || decision === "observation_passed"
      || decision === "stable_confirmed";
    return Object.freeze({
      schemaVersion: "1.0",
      contract: "worker_result",
      role: "rollout_babysitter",
      factoryRunId: candidate.factoryRunId,
      candidateHeadSha: candidate.headCommitSha,
      inputSha256: parseDigest(processed.accepted.acceptedRecordDigest),
      decision,
      facts: Object.freeze({
        candidateExposureBasisPoints: processed.summary.binding.candidateBasisPoints,
        stableAvailable: processed.summary.health.stable?.state === "healthy",
        observationComplete: decision === "observation_passed",
        telemetryPassed,
        unresolvedIncidentCount: processed.accepted.openIncidents.length
      })
    });
  }

  public async evaluateRollout(input: Readonly<{
    context: EffectInvocationContext;
    candidate: CandidateRelease;
    rollout: RolloutEvidence;
  }>): Promise<WorkerResult> {
    return await this.#evaluate(await this.evidenceProvider.loadRolloutEvidence(input), input.context, input.candidate);
  }

  public async evaluateObservation(input: Readonly<{
    context: EffectInvocationContext;
    candidate: CandidateRelease;
  }>): Promise<WorkerResult> {
    return await this.#evaluate(await this.evidenceProvider.loadObservationEvidence(input), input.context, input.candidate);
  }
}
