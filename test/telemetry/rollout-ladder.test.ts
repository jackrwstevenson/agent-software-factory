import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedEventJournal,
  IncidentStore,
  processTelemetryWindow,
  reduceTelemetryFrame,
  reduceTelemetryWindow,
  createStableReference,
  evaluateRollbackRestoration
} from "../../src/telemetry/index.js";
import { createRollbackRestorationFixture, populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

test("every rollout-policy/v1 ladder step requires fresh healthy evidence and proposes only the next phase-valid action", () => {
  const run = new TelemetryRunBuilder("ladder_001");
  const staging = populateHealthyWindow(run.createWindow("staging", "staging").open());
  assert.equal(processTelemetryWindow({ journal: run.journal, windowId: staging.binding.windowId }).proposal.proposal, "advance_to_rollout");

  const baseline = populateHealthyWindow(run.createWindow("stable_reference", "stable_reference").open());
  const baselineResult = processTelemetryWindow({ journal: run.journal, windowId: baseline.binding.windowId });
  assert.equal(baselineResult.proposal.proposal, "advance_exposure");
  const stableReference = createStableReference({
    summary: baselineResult.summary,
    assessment: baselineResult.assessment,
    acceptedObserverRecord: baselineResult.accepted
  });

  for (const gate of ["gate_5", "gate_10", "gate_30", "gate_50", "gate_80"] as const) {
    const window = populateHealthyWindow(run.createWindow(gate, gate).open());
    const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
    assert.equal(result.summary.binding.gate, gate);
    assert.equal(result.assessment.sufficiency.state, "complete_sufficient");
    assert.equal(result.proposal.proposal, "advance_exposure");
  }

  const observation = populateHealthyWindow(run.createWindow("observation", "observation", {
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open());
  const observed = processTelemetryWindow({
    journal: run.journal,
    windowId: observation.binding.windowId,
    pinnedStableReference: stableReference
  });
  assert.equal(observed.proposal.proposal, "observation_passed");
});

test("Telemetry Frames are immutable ordered prefixes and replay to the same digest", () => {
  const run = new TelemetryRunBuilder("frame_001");
  const window = run.createWindow("frame", "gate_50").open();
  window.addHealthyRequiredComponents(3).addRequests("stable", 2).addRequests("candidate", 2);
  const through = run.journal.snapshot().at(-1)?.ingestSequence;
  assert.ok(through);
  const frame = reduceTelemetryFrame(run.journal, window.binding.windowId, through);
  assert.equal(frame.completeness, "incomplete_interrupted");
  assert.equal(frame.acceptedEventEnd, through);
  const replayed = reduceTelemetryFrame(
    AcceptedEventJournal.replay(run.journal.snapshot()),
    window.binding.windowId,
    through
  );
  assert.deepEqual(replayed, frame);
});

test("Candidate response identity mismatch and confirmed unhealthiness trigger immediate rollback", () => {
  const mismatchRun = new TelemetryRunBuilder("identity_mismatch_001");
  const mismatch = mismatchRun.createWindow("identity_mismatch", "gate_30").open();
  mismatch.addHealthyRequiredComponents().addRequests("stable", 48);
  mismatch.addRequest("candidate", { responseIdentityVerified: false });
  mismatch.close();
  const mismatchResult = processTelemetryWindow({ journal: mismatchRun.journal, windowId: mismatch.binding.windowId });
  assert.equal(mismatchResult.summary.responseIdentityMismatchObserved, true);
  assert.equal(mismatchResult.proposal.proposal, "rollback");

  const unhealthyRun = new TelemetryRunBuilder("candidate_unhealthy_001");
  const unhealthy = unhealthyRun.createWindow("candidate_unhealthy", "gate_30").open();
  unhealthy.addHealth("candidate", ["unhealthy", "unhealthy", "unhealthy", ...Array.from({ length: 8 }, () => "healthy" as const)]);
  for (const component of ["stable", "router", "traffic"] as const) unhealthy.addHealth(component, Array.from({ length: 11 }, () => "healthy" as const));
  unhealthy.addRequests("stable", 48).addRequests("candidate", 48).close();
  assert.equal(processTelemetryWindow({ journal: unhealthyRun.journal, windowId: unhealthy.binding.windowId }).proposal.proposal, "rollback");
});

test("verified rollback restoration mitigates Candidate incidents without claiming Candidate recovery", () => {
  const run = new TelemetryRunBuilder("mitigation_001");
  const window = run.createWindow("candidate_failure", "gate_30").open();
  window.addHealthyRequiredComponents().addRequests("stable", 1);
  window.addRequest("candidate", { attemptOutcomes: ["http_error"], finalOutcome: "failed" }).close();
  const incidents = new IncidentStore();
  processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId, incidents });
  assert.equal(incidents.records[0]?.state, "open");

  const restorationFixture = createRollbackRestorationFixture("mitigation_restoration", 2);
  const restoration = evaluateRollbackRestoration({
    journal: restorationFixture.run.journal,
    factoryRunId: restorationFixture.run.factoryRunId,
    stableProcessIdentity: restorationFixture.stableIdentity,
    routingRevisionId: restorationFixture.window.binding.routingRevisionId,
    rollbackIntentAcceptedEventCursor: 0
  });
  assert.equal(restoration.proposal, "stable_confirmed");
  const mitigated = incidents.mitigateCandidateIncidents({
    sampleSequence: 2,
    windowId: "tw_rollback_confirmation",
    stableOnlyRoutingRevisionId: "rr_stable_only",
    stableHealthEvidenceDigest: restoration.evidenceDigest
  });
  assert.equal(mitigated.length, 1);
  assert.equal(incidents.records[0]?.state, "mitigated");
  assert.equal(incidents.records[0]?.resolution, null);
  assert.equal(incidents.records[0]?.mitigation?.kind, "stable_restored_without_candidate_recovery_claim");
  assert.deepEqual(IncidentStore.replay(incidents.snapshot()).snapshot(), incidents.snapshot());
});

test("monitoring gaps remain unusable even when metrics happen to meet sample floors", () => {
  const run = new TelemetryRunBuilder("monitoring_gap_policy_001");
  const window = run.createWindow("monitoring_gap", "gate_50").open();
  window.addHealthyRequiredComponents().addRequests("stable", 48).skipTrafficSourceSequence().addRequests("candidate", 48).close();
  const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(summary.metrics.stable.logicalRequestsFinished, 48);
  assert.equal(summary.metrics.candidate.logicalRequestsFinished, 48);
  assert.equal(summary.completeness, "incomplete_gap");
  assert.notEqual(result.proposal.proposal, "advance_exposure");
});
