import type { RolloutEvidence } from "../domain/factory-run.js";
import type { CandidateRelease, EffectInvocationContext } from "../protocol/contracts.js";

export interface ReleaseTopology {
  prepareRollout(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
  }): Promise<RolloutEvidence>;
}
