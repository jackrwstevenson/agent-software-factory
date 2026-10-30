import { AcceptedEventJournal } from "./accepted-event-journal.js";
import { assessTelemetryWindow, type StableReference, type StableReferenceSourceEvidence } from "./assessment.js";
import { IncidentStore } from "./incidents.js";
import {
  acceptObserverResult,
  buildObserverInput,
  invokeObserver,
  ObserverSession
} from "./observer.js";
import { invokeRolloutBabysitter } from "./rollout-babysitter.js";
import { ShortLivedTelemetryWorkers } from "./subprocess-workers.js";
import { buildBabysitterWorkerInput } from "./worker-protocol.js";
import { reduceTelemetryWindow, type ReduceWindowOptions } from "./window-reducer.js";

function reReduceStableReference(
  journal: AcceptedEventJournal,
  reference: StableReference | null
): StableReferenceSourceEvidence | null {
  if (reference === null) return null;
  try {
    const summary = reduceTelemetryWindow(journal, reference.windowId);
    const assessment = assessTelemetryWindow(summary);
    return Object.freeze({ summary, assessment });
  } catch {
    return null;
  }
}

export function processTelemetryWindow(input: Readonly<{
  journal: AcceptedEventJournal;
  windowId: string;
  incidents?: IncidentStore;
  observer?: ObserverSession;
  pinnedStableReference?: StableReference | null;
  reduceOptions?: ReduceWindowOptions;
  observerInvocationId?: string;
}>) {
  const incidents = input.incidents ?? new IncidentStore();
  const observer = input.observer ?? new ObserverSession();
  const summary = reduceTelemetryWindow(input.journal, input.windowId, input.reduceOptions);
  const stableReference = input.pinnedStableReference ?? null;
  const assessment = assessTelemetryWindow(summary, stableReference, reReduceStableReference(input.journal, stableReference));
  const observerInput = buildObserverInput(summary, assessment, incidents, observer);
  const observerResult = invokeObserver(observerInput, input.observerInvocationId);
  const accepted = acceptObserverResult(observerInput, observerResult, incidents, observer);
  const proposal = invokeRolloutBabysitter({
    phase: summary.binding.phase,
    summary,
    assessment,
    acceptedObserverRecord: accepted
  });
  return Object.freeze({ summary, assessment, observerInput, observerResult, accepted, proposal });
}

export async function processTelemetryWindowWithWorkers(input: Readonly<{
  journal: AcceptedEventJournal;
  windowId: string;
  incidents: IncidentStore;
  observer: ObserverSession;
  workers: ShortLivedTelemetryWorkers;
  pinnedStableReference?: StableReference | null;
  reduceOptions?: ReduceWindowOptions;
}>) {
  const summary = reduceTelemetryWindow(input.journal, input.windowId, input.reduceOptions);
  const stableReference = input.pinnedStableReference ?? null;
  const assessment = assessTelemetryWindow(summary, stableReference, reReduceStableReference(input.journal, stableReference));
  const observerInput = buildObserverInput(summary, assessment, input.incidents, input.observer);
  const observerWorker = await input.workers.runObserver(observerInput);
  const accepted = acceptObserverResult(observerInput, observerWorker.output, input.incidents, input.observer);
  const babysitterInput = buildBabysitterWorkerInput({ summary, assessment, acceptedObserverRecord: accepted });
  const babysitterWorker = await input.workers.runBabysitter(babysitterInput);
  return Object.freeze({
    summary, assessment, observerInput, observerResult: observerWorker.output, accepted,
    babysitterInput, proposal: babysitterWorker.output, observerWorker, babysitterWorker
  });
}
