import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { Digest, FactoryRunId, GitObjectId } from "../protocol/contracts.js";
import {
  validateProposalForPhase,
  type BabysitterProposal
} from "../telemetry/rollout-babysitter.js";
import { ROLLOUT_LADDER, gatePolicy } from "../telemetry/rollout-policy.js";
import type { RolloutGate, TelemetryPhase } from "../telemetry/contracts.js";

export interface AcceptedGateEvidence {
  readonly gate: RolloutGate;
  readonly phase: TelemetryPhase;
  readonly windowId: string;
  readonly candidateBasisPoints: number;
  readonly durationMs: number;
  readonly completeness: "complete";
  readonly sufficient: true;
  readonly identityBindingVerified: true;
  readonly stableAvailable: true;
  readonly stableFinishedUsers: number;
  readonly stableFinishedRequests: number;
  readonly candidateFinishedUsers: number;
  readonly candidateFinishedRequests: number;
  readonly acceptedJournalCursor: number;
  readonly acceptedObserverRecordDigest: Digest;
  readonly acceptedBabysitterProposalDigest: Digest;
  readonly proposal: BabysitterProposal;
  readonly incidentTransition: "none" | "opened" | "updated" | "resolved";
  readonly evidenceDigest: Digest;
}

export interface AppliedExposure {
  readonly revisionId: string;
  readonly candidateBasisPoints: number;
  readonly fullFingerprint: Digest;
  readonly readBackVerified: true;
}

export interface RollbackRestorationEvidence {
  readonly stableOnlyRevisionId: string;
  readonly rollbackIntentSequence: number;
  readonly routingReadBackSequence: number;
  readonly routingReadBackVerified: true;
  readonly stableIdentityVerified: true;
  readonly stableProbeEventIds: readonly [string, string, ...string[]];
  readonly candidateRequestsAfterReadBack: 0;
  readonly evidenceDigest: Digest;
}

export interface SuccessFinalizationEvidence {
  readonly integrationCommitSha: GitObjectId;
  readonly candidateTreeSha: GitObjectId;
  readonly integrationTreeSha: GitObjectId;
  readonly defaultBranchVerified: true;
  readonly terminalProjectionVerified: true;
  readonly cleanupReconciled: true;
  readonly replayEvidenceDigest: Digest;
}

export interface ProgressiveRolloutEnvironment {
  prepare(): Promise<void>;
  applyExposure(input: { readonly candidateBasisPoints: number; readonly reason: string }): Promise<AppliedExposure>;
  collectAcceptedGateEvidence(input: { readonly gate: RolloutGate; readonly evaluationOrdinal: number }): Promise<AcceptedGateEvidence>;
  restoreStable(input: { readonly rollbackIntentSequence: number }): Promise<RollbackRestorationEvidence>;
  finalizeSuccess(): Promise<SuccessFinalizationEvidence>;
  shutdown(input: { readonly terminalOutcome: "succeeded" | "rolled_back" }): Promise<readonly string[]>;
}

type EvidenceEventPayloads = {
  prepared: Readonly<{ policyId: "rollout-policy/v1"; candidateHeadSha: GitObjectId }>;
  routing_applied: Readonly<{ gate: RolloutGate } & AppliedExposure>;
  gate_evaluated: AcceptedGateEvidence;
  rollback_intent: Readonly<{ gate: RolloutGate; acceptedBabysitterProposalDigest: Digest }>;
  rollback_verified: RollbackRestorationEvidence;
  success_finalized: SuccessFinalizationEvidence;
  terminal: Readonly<{ terminalOutcome: "succeeded" | "rolled_back" }>;
  cleanup: Readonly<{ stopped: readonly string[] }>;
};

type EvidenceEventKind = keyof EvidenceEventPayloads;
export type RolloutEvidenceEvent = {
  [K in EvidenceEventKind]: Readonly<{
    sequence: number;
    previousDigest: Digest | null;
    kind: K;
    payload: EvidenceEventPayloads[K];
    digest: Digest;
  }>
}[EvidenceEventKind];

export interface RolloutEvidenceBundle {
  readonly factoryRunId: FactoryRunId;
  readonly candidateHeadSha: GitObjectId;
  readonly terminalOutcome: "succeeded" | "rolled_back";
  readonly events: readonly RolloutEvidenceEvent[];
  readonly evidenceBundleDigest: Digest;
}

class EvidenceBundleBuilder {
  readonly events: RolloutEvidenceEvent[] = [];
  constructor(readonly factoryRunId: FactoryRunId, readonly candidateHeadSha: GitObjectId) {}

  append<K extends EvidenceEventKind>(kind: K, payload: EvidenceEventPayloads[K]): number {
    const sequence = this.events.length + 1;
    const previousDigest = this.events.at(-1)?.digest ?? null;
    const core = { sequence, previousDigest, kind, payload };
    this.events.push(Object.freeze({ ...core, digest: canonicalSha256(core) }) as RolloutEvidenceEvent);
    return sequence;
  }

  finish(terminalOutcome: RolloutEvidenceBundle["terminalOutcome"]): RolloutEvidenceBundle {
    const core = { factoryRunId: this.factoryRunId, candidateHeadSha: this.candidateHeadSha, terminalOutcome, events: this.events };
    return Object.freeze({ ...core, events: Object.freeze([...this.events]), evidenceBundleDigest: canonicalSha256(core) });
  }
}

function phaseFor(gate: RolloutGate): TelemetryPhase {
  if (gate === "staging") return "staging";
  if (gate === "stable_reference") return "stable_reference";
  if (gate === "observation") return "observation";
  return "rollout";
}

function validateAcceptedEvidence(gate: RolloutGate, evidence: AcceptedGateEvidence): void {
  const policy = gatePolicy(gate);
  const expectedBasisPoints = policy.candidateBasisPoints ?? 0;
  if (evidence.gate !== gate || evidence.phase !== phaseFor(gate) || evidence.candidateBasisPoints !== expectedBasisPoints) {
    throw new Error(`accepted telemetry evidence is stale for ${gate}`);
  }
  if (evidence.durationMs < policy.minimumDurationMs || !evidence.identityBindingVerified || !evidence.stableAvailable) {
    throw new Error(`accepted telemetry evidence is incomplete for ${gate}`);
  }
  const floors = [
    policy.stable === null || (evidence.stableFinishedUsers >= policy.stable.minimumUniqueFinishedUsers && evidence.stableFinishedRequests >= policy.stable.minimumFinishedRequests),
    policy.candidate === null || (evidence.candidateFinishedUsers >= policy.candidate.minimumUniqueFinishedUsers && evidence.candidateFinishedRequests >= policy.candidate.minimumFinishedRequests)
  ];
  if (!floors.every(Boolean) || evidence.acceptedJournalCursor < 1) throw new Error(`accepted telemetry evidence is insufficient for ${gate}`);
  validateProposalForPhase(evidence.phase, evidence.proposal);
  const expectedDigest = canonicalSha256({
    gate: evidence.gate,
    phase: evidence.phase,
    windowId: evidence.windowId,
    acceptedJournalCursor: evidence.acceptedJournalCursor,
    acceptedObserverRecordDigest: evidence.acceptedObserverRecordDigest,
    acceptedBabysitterProposalDigest: evidence.acceptedBabysitterProposalDigest,
    proposal: evidence.proposal,
    incidentTransition: evidence.incidentTransition
  });
  if (expectedDigest !== evidence.evidenceDigest) throw new Error(`accepted telemetry evidence digest mismatch for ${gate}`);
}

async function applyGateExposure(environment: ProgressiveRolloutEnvironment, bundle: EvidenceBundleBuilder, gate: RolloutGate): Promise<void> {
  const candidateBasisPoints = gatePolicy(gate).candidateBasisPoints ?? 0;
  const revision = await environment.applyExposure({ candidateBasisPoints, reason: `enter:${gate}` });
  if (!revision.readBackVerified || revision.candidateBasisPoints !== candidateBasisPoints) throw new Error(`routing read-back failed for ${gate}`);
  bundle.append("routing_applied", { gate, ...revision });
}

async function executeRollback(
  environment: ProgressiveRolloutEnvironment,
  bundle: EvidenceBundleBuilder,
  gate: RolloutGate,
  proposalDigest: Digest
): Promise<RolloutEvidenceBundle> {
  const rollbackIntentSequence = bundle.append("rollback_intent", { gate, acceptedBabysitterProposalDigest: proposalDigest });
  const restored = await environment.restoreStable({ rollbackIntentSequence });
  if (
    restored.rollbackIntentSequence !== rollbackIntentSequence ||
    restored.routingReadBackSequence <= rollbackIntentSequence ||
    !restored.routingReadBackVerified ||
    !restored.stableIdentityVerified ||
    restored.stableProbeEventIds.length < 2 ||
    restored.candidateRequestsAfterReadBack !== 0
  ) throw new Error("Stable-only rollback restoration did not satisfy the ordered safety proof");
  bundle.append("rollback_verified", restored);
  bundle.append("terminal", { terminalOutcome: "rolled_back" });
  bundle.append("cleanup", { stopped: await environment.shutdown({ terminalOutcome: "rolled_back" }) });
  return bundle.finish("rolled_back");
}

export async function runProgressiveRollout(input: Readonly<{
  factoryRunId: FactoryRunId;
  candidateHeadSha: GitObjectId;
  environment: ProgressiveRolloutEnvironment;
}>): Promise<RolloutEvidenceBundle> {
  const bundle = new EvidenceBundleBuilder(input.factoryRunId, input.candidateHeadSha);
  await input.environment.prepare();
  bundle.append("prepared", { policyId: "rollout-policy/v1", candidateHeadSha: input.candidateHeadSha });

  for (const gate of ROLLOUT_LADDER) {
    if (gate !== "staging") await applyGateExposure(input.environment, bundle, gate);
    let advanced = false;
    for (let evaluationOrdinal = 1; evaluationOrdinal <= 4; evaluationOrdinal += 1) {
      const evidence = await input.environment.collectAcceptedGateEvidence({ gate, evaluationOrdinal });
      validateAcceptedEvidence(gate, evidence);
      bundle.append("gate_evaluated", evidence);
      if (evidence.proposal === "rollback") {
        return executeRollback(input.environment, bundle, gate, evidence.acceptedBabysitterProposalDigest);
      }
      if (evidence.proposal === "pause") throw new Error(`rollout paused at ${gate}`);
      const expected = gate === "staging" ? "advance_to_rollout" : gate === "observation" ? "observation_passed" : "advance_exposure";
      if (evidence.proposal === expected) {
        if (evidence.incidentTransition === "opened" || evidence.incidentTransition === "updated") throw new Error(`unresolved Incident cannot advance ${gate}`);
        advanced = true;
        break;
      }
      if (evidence.proposal !== "hold" && evidence.proposal !== "continue_observation" && evidence.proposal !== "incident") {
        throw new Error(`illegal accepted proposal ${evidence.proposal} at ${gate}`);
      }
    }
    if (!advanced) throw new Error(`rollout did not produce fresh advancing evidence at ${gate}`);
  }

  const finalized = await input.environment.finalizeSuccess();
  if (
    finalized.integrationTreeSha !== finalized.candidateTreeSha ||
    !finalized.defaultBranchVerified ||
    !finalized.terminalProjectionVerified ||
    !finalized.cleanupReconciled
  ) throw new Error("success finalization failed exact-tree, GitHub projection, or cleanup verification");
  bundle.append("success_finalized", finalized);
  bundle.append("terminal", { terminalOutcome: "succeeded" });
  bundle.append("cleanup", { stopped: await input.environment.shutdown({ terminalOutcome: "succeeded" }) });
  return bundle.finish("succeeded");
}

export function replayRolloutEvidenceBundle(bundle: RolloutEvidenceBundle): RolloutEvidenceBundle {
  let previousDigest: Digest | null = null;
  for (const [index, event] of bundle.events.entries()) {
    if (event.sequence !== index + 1 || event.previousDigest !== previousDigest) throw new Error("rollout evidence sequence or digest chain is invalid");
    if (canonicalSha256({ sequence: event.sequence, previousDigest: event.previousDigest, kind: event.kind, payload: event.payload }) !== event.digest) {
      throw new Error("rollout evidence event digest mismatch");
    }
    previousDigest = event.digest;
  }
  const core = { factoryRunId: bundle.factoryRunId, candidateHeadSha: bundle.candidateHeadSha, terminalOutcome: bundle.terminalOutcome, events: bundle.events };
  if (canonicalSha256(core) !== bundle.evidenceBundleDigest) throw new Error("rollout Evidence Bundle digest mismatch");
  return structuredClone(bundle);
}
