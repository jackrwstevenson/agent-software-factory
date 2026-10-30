import assert from "node:assert/strict";
import test from "node:test";

import {
  replayRolloutEvidenceBundle,
  runProgressiveRollout,
  type AcceptedGateEvidence,
  type ProgressiveRolloutEnvironment
} from "../../src/orchestrator/progressive-rollout.js";
import { canonicalSha256 } from "../../src/protocol/canonical-json.js";
import { parseDigest, parseFactoryRunId, parseGitObjectId } from "../../src/protocol/contracts.js";
import { gatePolicy } from "../../src/telemetry/rollout-policy.js";
import type { RolloutGate, TelemetryPhase } from "../../src/telemetry/contracts.js";
import type { BabysitterProposal } from "../../src/telemetry/rollout-babysitter.js";

function phaseFor(gate: RolloutGate): TelemetryPhase {
  if (gate === "staging") return "staging";
  if (gate === "stable_reference") return "stable_reference";
  if (gate === "observation") return "observation";
  return "rollout";
}

class ScriptedEnvironment implements ProgressiveRolloutEnvironment {
  readonly calls: string[] = [];
  readonly gateCalls = new Map<RolloutGate, number>();
  constructor(readonly fatalAt30 = false, readonly transientAt30 = false) {}
  async prepare() { this.calls.push("prepare"); }
  async applyExposure(input: { candidateBasisPoints: number; reason: string }) {
    this.calls.push(`route:${input.candidateBasisPoints}`);
    return { revisionId: `rr-${this.calls.length}`, candidateBasisPoints: input.candidateBasisPoints, fullFingerprint: canonicalSha256(input), readBackVerified: true as const };
  }
  async collectAcceptedGateEvidence(input: { gate: RolloutGate; evaluationOrdinal: number }): Promise<AcceptedGateEvidence> {
    const ordinal = (this.gateCalls.get(input.gate) ?? 0) + 1;
    this.gateCalls.set(input.gate, ordinal);
    this.calls.push(`window:${input.gate}:${ordinal}`);
    let proposal: BabysitterProposal = input.gate === "staging" ? "advance_to_rollout" : input.gate === "observation" ? "observation_passed" : "advance_exposure";
    let incidentTransition: AcceptedGateEvidence["incidentTransition"] = "none";
    if (input.gate === "gate_30" && this.fatalAt30 && ordinal === 1) { proposal = "rollback"; incidentTransition = "opened"; }
    else if (input.gate === "gate_30" && this.transientAt30 && ordinal === 1) { proposal = "hold"; incidentTransition = "opened"; }
    else if (input.gate === "gate_30" && this.transientAt30 && ordinal === 2) { proposal = "hold"; incidentTransition = "updated"; }
    else if (input.gate === "gate_30" && this.transientAt30 && ordinal === 3) { proposal = "advance_exposure"; incidentTransition = "resolved"; }
    const policy = gatePolicy(input.gate);
    const phase = phaseFor(input.gate);
    const observer = canonicalSha256({ input, ordinal, worker: "observer" });
    const babysitter = canonicalSha256({ input, ordinal, worker: "rollout_babysitter", proposal });
    const core = { gate: input.gate, phase, windowId: `tw-${input.gate}-${ordinal}`, acceptedJournalCursor: ordinal * 100, acceptedObserverRecordDigest: observer, acceptedBabysitterProposalDigest: babysitter, proposal, incidentTransition };
    return {
      gate: input.gate,
      phase,
      windowId: core.windowId,
      candidateBasisPoints: policy.candidateBasisPoints ?? 0,
      durationMs: policy.minimumDurationMs,
      completeness: "complete",
      sufficient: true,
      identityBindingVerified: true,
      stableAvailable: true,
      stableFinishedUsers: policy.stable?.minimumUniqueFinishedUsers ?? 3,
      stableFinishedRequests: policy.stable?.minimumFinishedRequests ?? 3,
      candidateFinishedUsers: policy.candidate?.minimumUniqueFinishedUsers ?? 0,
      candidateFinishedRequests: policy.candidate?.minimumFinishedRequests ?? 0,
      acceptedJournalCursor: core.acceptedJournalCursor,
      acceptedObserverRecordDigest: observer,
      acceptedBabysitterProposalDigest: babysitter,
      proposal,
      incidentTransition,
      evidenceDigest: canonicalSha256(core)
    };
  }
  async restoreStable(input: { rollbackIntentSequence: number }) {
    this.calls.push(`rollback-intent:${input.rollbackIntentSequence}`);
    this.calls.push("route-readback:stable-only");
    this.calls.push("stable-probe:1");
    this.calls.push("stable-probe:2");
    return { stableOnlyRevisionId: "rr-stable", rollbackIntentSequence: input.rollbackIntentSequence, routingReadBackSequence: input.rollbackIntentSequence + 1, routingReadBackVerified: true as const, stableIdentityVerified: true as const, stableProbeEventIds: ["probe-1", "probe-2"] as const, candidateRequestsAfterReadBack: 0 as const, evidenceDigest: parseDigest("a".repeat(64)) };
  }
  async finalizeSuccess() {
    this.calls.push("integrate-exact-tree");
    this.calls.push("terminal-project");
    this.calls.push("source-cleanup");
    const tree = parseGitObjectId("2".repeat(40));
    return { integrationCommitSha: parseGitObjectId("3".repeat(40)), candidateTreeSha: tree, integrationTreeSha: tree, defaultBranchVerified: true as const, terminalProjectionVerified: true as const, cleanupReconciled: true as const, replayEvidenceDigest: parseDigest("b".repeat(64)) };
  }
  async shutdown(input: { terminalOutcome: "succeeded" | "rolled_back" }) {
    this.calls.push(`shutdown:${input.terminalOutcome}`);
    return ["synthetic-traffic", "router", "candidate", "staging", "stable"];
  }
}

const factoryRunId = parseFactoryRunId("fr_progressive_rollout");
const candidateHeadSha = parseGitObjectId("1".repeat(40));

test("Phase 8 happy path holds for a recoverable 30% Incident, finalizes exact-tree success, and replays identically", async () => {
  const environment = new ScriptedEnvironment(false, true);
  const bundle = await runProgressiveRollout({ factoryRunId, candidateHeadSha, environment });
  assert.equal(bundle.terminalOutcome, "succeeded");
  assert.deepEqual(environment.calls.filter((call) => call.startsWith("route:")), ["route:0", "route:500", "route:1000", "route:3000", "route:5000", "route:8000", "route:10000"]);
  assert.deepEqual(environment.calls.filter((call) => call.startsWith("window:gate_30")), ["window:gate_30:1", "window:gate_30:2", "window:gate_30:3"]);
  assert.ok(environment.calls.indexOf("integrate-exact-tree") < environment.calls.indexOf("terminal-project"));
  assert.ok(environment.calls.indexOf("terminal-project") < environment.calls.indexOf("source-cleanup"));
  assert.deepEqual(replayRolloutEvidenceBundle(bundle), bundle);
});

test("fatal Candidate failure proves ordered rollback safety evidence and sends no later Candidate traffic", async () => {
  const environment = new ScriptedEnvironment(true);
  const bundle = await runProgressiveRollout({ factoryRunId, candidateHeadSha, environment });
  assert.equal(bundle.terminalOutcome, "rolled_back");
  const rollbackIntent = environment.calls.findIndex((call) => call.startsWith("rollback-intent:"));
  assert.ok(rollbackIntent >= 0);
  assert.ok(rollbackIntent < environment.calls.indexOf("route-readback:stable-only"));
  assert.ok(environment.calls.indexOf("route-readback:stable-only") < environment.calls.indexOf("stable-probe:1"));
  assert.ok(environment.calls.indexOf("stable-probe:1") < environment.calls.indexOf("stable-probe:2"));
  assert.equal(environment.calls.some((call) => call === "route:5000"), false);
  assert.equal(bundle.events.filter((event) => event.kind === "rollback_verified").length, 1);
  assert.deepEqual(replayRolloutEvidenceBundle(bundle), bundle);
});
