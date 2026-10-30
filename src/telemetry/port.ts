import type { RolloutEvidence } from "../domain/factory-run.js";
import type {
  CandidateRelease,
  EffectInvocationContext,
  WorkerResult
} from "../protocol/contracts.js";

export interface TelemetryEngine {
  evaluateRollout(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
    readonly rollout: RolloutEvidence;
  }): Promise<WorkerResult>;
  evaluateObservation(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
  }): Promise<WorkerResult>;
}
