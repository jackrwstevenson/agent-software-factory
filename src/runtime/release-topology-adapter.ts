import { join } from "node:path";
import type { RolloutEvidence } from "../domain/factory-run.js";
import type { CandidateRelease, EffectInvocationContext } from "../protocol/contracts.js";
import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { ReleaseTopology } from "./port.js";
import { LocalReleaseTopology, type TopologyOptions } from "./local-release-topology.js";

export interface LocalReleaseTopologyAdapterOptions {
  readonly stateRoot: string;
  readonly stableReleaseId: string;
  readonly rolloutSeedFor: (input: { readonly context: EffectInvocationContext; readonly candidate: CandidateRelease }) => string;
  readonly topology?: TopologyOptions;
}

export class LocalReleaseTopologyAdapter implements ReleaseTopology {
  private active: LocalReleaseTopology | null = null;

  constructor(private readonly options: LocalReleaseTopologyAdapterOptions) {}

  async prepareRollout(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
  }): Promise<RolloutEvidence> {
    const topology = new LocalReleaseTopology({
      factoryRunId: input.context.factoryRunId,
      runDirectory: join(this.options.stateRoot, "runs", input.context.factoryRunId, "runtime"),
      stableReleaseId: this.options.stableReleaseId,
      candidateReleaseId: `candidate:${input.candidate.headCommitSha}`,
      rolloutSeed: this.options.rolloutSeedFor(input)
    }, this.options.topology);
    this.active = topology;
    const snapshot = await topology.start();
    return {
      candidateHeadSha: input.candidate.headCommitSha,
      stagingPassed: snapshot.instances.some((item) => item.processKind === "staging_release" && item.observedState === "ready"),
      allProgressiveGatesPassed: false,
      candidateExposureBasisPoints: snapshot.routing?.candidateBasisPoints ?? 0,
      stableAvailable: snapshot.instances.some((item) => item.processKind === "stable_release" && item.observedState === "ready"),
      evidenceDigest: canonicalSha256(snapshot)
    };
  }

  activeTopology(): LocalReleaseTopology | null {
    return this.active;
  }
}
