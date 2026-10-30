import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedEventJournal,
  IncidentStore,
  ObserverSession,
  ProtocolConflict,
  WorkerUnavailable,
  acceptObserverResult,
  assessTelemetryWindow,
  buildObserverInput,
  createStableReference,
  invokeObserver,
  invokeRolloutBabysitter,
  observerUnavailableFact,
  orchestratorSafetyInterlock,
  processTelemetryWindow,
  reduceTelemetryWindow,
  validateProposalForPhase,
  type AcceptedObserverRecord,
  type ObserverResult
} from "../../src/telemetry/index.js";
import { populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

test("golden 01: healthy mixed exposure advances with concurrent Stable control", () => {
  const run = new TelemetryRunBuilder("golden_01");
  const window = populateHealthyWindow(run.createWindow("mixed", "gate_50").open());
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.summary.completeness, "complete");
  assert.equal(result.assessment.sufficiency.state, "complete_sufficient");
  assert.equal(result.proposal.proposal, "advance_exposure");
});

test("golden 02: complete but insufficient evidence holds without claiming health", () => {
  const run = new TelemetryRunBuilder("golden_02");
  const window = run.createWindow("insufficient", "gate_50").open();
  window.addHealthyRequiredComponents().addRequests("stable", 2).addRequests("candidate", 2).close();
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.summary.completeness, "complete");
  assert.equal(result.assessment.sufficiency.state, "complete_insufficient_samples");
  assert.equal(result.assessment.signals.candidateLatency, "insufficient_evidence");
  assert.equal(result.proposal.proposal, "hold");
});

test("golden 03: Candidate final failure remains a breach below sample floors", () => {
  const run = new TelemetryRunBuilder("golden_03");
  const window = run.createWindow("negative", "gate_30").open();
  window.addHealthyRequiredComponents().addRequests("stable", 1);
  window.addRequest("candidate", { attemptOutcomes: ["http_error"], finalOutcome: "failed" }).close();
  const incidents = new IncidentStore();
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId, incidents });
  assert.equal(result.assessment.sufficiency.state, "complete_insufficient_samples");
  assert.equal(result.assessment.signals.candidateError, "breached");
  assert.equal(result.proposal.proposal, "rollback");
  assert.equal(incidents.openSummaries()[0]?.conditionId, "candidate.request_failure");
});

test("golden 04: transient retry stays Candidate-attributed without becoming missing evidence", () => {
  const run = new TelemetryRunBuilder("golden_04");
  const window = run.createWindow("retry", "gate_50").open();
  window.addHealthyRequiredComponents();
  window.addRequests("stable", 48);
  window.addRequests("candidate", 48, {
    attemptOutcomes: (index) => index === 0 ? ["http_error", "success"] : ["success"]
  });
  window.close();
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.summary.metrics.candidate.retries, 1);
  assert.equal(result.summary.metrics.candidate.finalFailures, 0);
  assert.equal(result.summary.metrics.candidate.attemptOutcomes.http_error, 1);
  assert.equal(result.assessment.signals.candidateError, "healthy");
  assert.equal(result.proposal.proposal, "advance_exposure");
});

test("golden 05: Candidate latency regression uses concurrent Stable metrics", () => {
  const run = new TelemetryRunBuilder("golden_05");
  const window = populateHealthyWindow(run.createWindow("latency", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 45
  });
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.assessment.signals.candidateLatency, "regressed");
  assert.equal(result.assessment.conditions[0]?.evidence.referenceWindowId, window.binding.windowId);
  assert.equal(result.proposal.proposal, "hold");
});

test("golden 06: Candidate recovered-attempt error regression holds", () => {
  const run = new TelemetryRunBuilder("golden_06");
  const window = run.createWindow("retry_regression", "gate_50").open();
  window.addHealthyRequiredComponents().addRequests("stable", 48);
  window.addRequests("candidate", 48, {
    attemptOutcomes: (index) => index < 6 ? ["http_error", "success"] : ["success"]
  });
  window.close();
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.summary.metrics.candidate.finalFailures, 0);
  assert.equal(result.assessment.signals.candidateError, "regressed");
  assert.equal(result.proposal.proposal, "hold");
});

test("golden 07: Stable failure invalidates the control and pauses", () => {
  const run = new TelemetryRunBuilder("golden_07");
  const window = run.createWindow("stable_failure", "gate_50").open();
  window.addHealthyRequiredComponents();
  window.addRequests("stable", 47).addRequest("stable", { attemptOutcomes: ["http_error"], finalOutcome: "failed" });
  window.addRequests("candidate", 48).close();
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.assessment.signals.stableError, "breached");
  assert.equal(result.proposal.proposal, "pause");
});

test("golden 08: health degradation, unhealthy threshold, mismatch, and exit remain distinct", () => {
  const degradedRun = new TelemetryRunBuilder("golden_08_degraded");
  const degraded = degradedRun.createWindow("degraded", "gate_50").open();
  degraded.addHealth("candidate", ["unhealthy", ...Array.from({ length: 10 }, () => "healthy" as const)]);
  for (const name of ["stable", "router", "traffic"] as const) degraded.addHealth(name, Array.from({ length: 11 }, () => "healthy" as const));
  degraded.addRequests("stable", 48).addRequests("candidate", 48).close();
  const degradedResult = processTelemetryWindow({ journal: degradedRun.journal, windowId: degraded.binding.windowId });
  assert.equal(degradedResult.summary.health.candidate?.state, "degraded");
  assert.equal(degradedResult.proposal.proposal, "hold");

  const unhealthyRun = new TelemetryRunBuilder("golden_08_unhealthy");
  const unhealthy = unhealthyRun.createWindow("unhealthy", "gate_50").open();
  unhealthy.addHealth("candidate", ["unhealthy", "unhealthy", "unhealthy", ...Array.from({ length: 8 }, () => "healthy" as const)]);
  for (const name of ["stable", "router", "traffic"] as const) unhealthy.addHealth(name, Array.from({ length: 11 }, () => "healthy" as const));
  unhealthy.addRequests("stable", 48).addRequests("candidate", 48).close();
  assert.equal(processTelemetryWindow({ journal: unhealthyRun.journal, windowId: unhealthy.binding.windowId }).proposal.proposal, "rollback");

  const mismatchRun = new TelemetryRunBuilder("golden_08_mismatch");
  const mismatch = mismatchRun.createWindow("mismatch", "gate_50").open();
  mismatch.addHealth("candidate", Array.from({ length: 11 }, () => "healthy" as const), { identityMismatchAt: 3 });
  for (const name of ["stable", "router", "traffic"] as const) mismatch.addHealth(name, Array.from({ length: 11 }, () => "healthy" as const));
  mismatch.addRequests("stable", 48).addRequests("candidate", 48).close();
  assert.equal(processTelemetryWindow({ journal: mismatchRun.journal, windowId: mismatch.binding.windowId }).proposal.proposal, "rollback");

  const exitRun = new TelemetryRunBuilder("golden_08_exit");
  const exited = populateHealthyWindow(exitRun.createWindow("exit", "gate_50").open()).addProcessExit("candidate");
  assert.equal(processTelemetryWindow({ journal: exitRun.journal, windowId: exited.binding.windowId }).proposal.proposal, "rollback");
});

test("golden 09: Candidate crash interlocks traffic before a separate rollback proposal", () => {
  const run = new TelemetryRunBuilder("golden_09");
  const window = run.createWindow("crash", "gate_30").open();
  window.addHealthyRequiredComponents().addRequests("stable", 48).addRequests("candidate", 1).addProcessExit("candidate").close();
  const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const interlock = orchestratorSafetyInterlock(summary);
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.deepEqual(interlock, {
    authority: "orchestrator",
    action: "stop_new_synthetic_traffic",
    reason: "immediate_reversible_safety_interlock",
    lifecycleTransition: null
  });
  assert.equal(result.proposal.proposal, "rollback");
});

test("golden 10: Router disagreement and missing Synthetic Traffic coverage fail closed", () => {
  const routerRun = new TelemetryRunBuilder("golden_10_router");
  const router = routerRun.createWindow("router_disagrees", "gate_50").open();
  for (const name of ["stable", "candidate", "traffic"] as const) router.addHealth(name, Array.from({ length: 11 }, () => "healthy" as const));
  router.addHealth("router", Array.from({ length: 11 }, () => "healthy" as const), { reportedRoutingRevisionId: "rr_wrong" });
  router.addRequests("stable", 48).addRequests("candidate", 48).close();
  assert.equal(processTelemetryWindow({ journal: routerRun.journal, windowId: router.binding.windowId }).proposal.proposal, "pause");

  const missingRun = new TelemetryRunBuilder("golden_10_missing");
  const missing = missingRun.createWindow("missing_traffic", "gate_50").open();
  for (const name of ["stable", "candidate", "router"] as const) missing.addHealth(name, Array.from({ length: 11 }, () => "healthy" as const));
  missing.addRequests("stable", 48).addRequests("candidate", 48).close();
  const missingResult = processTelemetryWindow({ journal: missingRun.journal, windowId: missing.binding.windowId });
  assert.equal(missingResult.summary.completeness, "incomplete_gap");
  assert.equal(missingResult.proposal.proposal, "hold");
});

test("golden 11: 100% Observation uses a valid pinned Stable reference and live Stable health", () => {
  const run = new TelemetryRunBuilder("golden_11");
  const baseline = populateHealthyWindow(run.createWindow("baseline", "stable_reference").open());
  const baselineResult = processTelemetryWindow({ journal: run.journal, windowId: baseline.binding.windowId });
  const reference = createStableReference({
    summary: baselineResult.summary,
    assessment: baselineResult.assessment,
    acceptedObserverRecord: baselineResult.accepted
  });
  const observation = populateHealthyWindow(run.createWindow("observation", "observation", {
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open());
  const result = processTelemetryWindow({ journal: run.journal, windowId: observation.binding.windowId, pinnedStableReference: reference });
  assert.equal(result.assessment.reference.state, "valid");
  assert.equal(result.summary.metrics.stable.logicalRequestsFinished, 0);
  assert.equal(result.summary.health.stable?.state, "healthy");
  assert.equal(result.proposal.proposal, "observation_passed");
});

test("golden 12: changed Stable Process Attempt invalidates the pinned performance reference", () => {
  const run = new TelemetryRunBuilder("golden_12_baseline");
  const baseline = populateHealthyWindow(run.createWindow("baseline", "stable_reference").open());
  const baselineResult = processTelemetryWindow({ journal: run.journal, windowId: baseline.binding.windowId });
  const reference = createStableReference({
    summary: baselineResult.summary,
    assessment: baselineResult.assessment,
    acceptedObserverRecord: baselineResult.accepted
  });
  const changedRun = new TelemetryRunBuilder("golden_12_changed");
  const observation = populateHealthyWindow(changedRun.createWindow("observation", "observation", {
    stableProcessAttempt: 99,
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open());
  const result = processTelemetryWindow({ journal: changedRun.journal, windowId: observation.binding.windowId, pinnedStableReference: reference });
  assert.equal(result.assessment.reference.state, "invalid");
  assert.ok(result.assessment.reference.reasons.includes("stable_process_attempt_changed"));
  assert.equal(result.proposal.proposal, "pause");
});

test("golden 13: monitoring gaps, exact duplicates, conflicts, and stale bindings diverge", () => {
  const run = new TelemetryRunBuilder("golden_13");
  const window = populateHealthyWindow(run.createWindow("states", "gate_50").open());
  const exact = run.journal.snapshot().find((event) => event.eventType === "request_finished");
  assert.ok(exact);
  assert.equal(run.journal.accept(exact).duplicate, true);
  assert.equal(reduceTelemetryWindow(run.journal, window.binding.windowId).completeness, "complete");
  assert.equal(reduceTelemetryWindow(run.journal, window.binding.windowId, { activeTopologyEpoch: 99 }).completeness, "stale");

  assert.throws(
    () => run.journal.accept({ ...exact, payload: { ...exact.payload, durationMs: 999 }, payloadDigest: exact.payloadDigest }),
    (error: unknown) => error instanceof ProtocolConflict
  );
  assert.equal(reduceTelemetryWindow(run.journal, window.binding.windowId).completeness, "invalid_conflict");

  const gapRun = new TelemetryRunBuilder("golden_13_gap");
  const gap = gapRun.createWindow("gap", "gate_50").open();
  gap.addHealthyRequiredComponents().addRequests("stable", 48).skipTrafficSourceSequence().addRequests("candidate", 48).close();
  assert.equal(reduceTelemetryWindow(gapRun.journal, gap.binding.windowId).completeness, "incomplete_gap");
});

test("golden 14: process restart starts a new epoch/window without carrying health streaks", () => {
  const run = new TelemetryRunBuilder("golden_14");
  const first = run.createWindow("epoch_1", "gate_50", { topologyEpoch: 1 }).open();
  first.addHealth("candidate", ["unhealthy", "unhealthy", ...Array.from({ length: 9 }, () => "healthy" as const)]);
  for (const name of ["stable", "router", "traffic"] as const) first.addHealth(name, Array.from({ length: 11 }, () => "healthy" as const));
  first.addRequests("stable", 48).addRequests("candidate", 48).close();
  const second = populateHealthyWindow(run.createWindow("epoch_2", "gate_50", { topologyEpoch: 2 }).open());
  const firstSummary = reduceTelemetryWindow(run.journal, first.binding.windowId);
  const secondSummary = reduceTelemetryWindow(run.journal, second.binding.windowId);
  assert.equal(firstSummary.health.candidate?.state, "degraded");
  assert.equal(secondSummary.health.candidate?.state, "healthy");
  assert.equal(secondSummary.health.candidate?.longestConsecutiveFailures, 0);
  assert.notEqual(firstSummary.binding.components.candidate?.processAttempt, secondSummary.binding.components.candidate?.processAttempt);
});

test("golden 15: incident open, update, resolve, and recurrence persist deterministically", () => {
  const run = new TelemetryRunBuilder("golden_15");
  const badOne = populateHealthyWindow(run.createWindow("bad_1", "gate_50").open(), { stableLatencyMs: 10, candidateLatencyMs: 45 });
  const badTwo = populateHealthyWindow(run.createWindow("bad_2", "gate_50").open(), { stableLatencyMs: 10, candidateLatencyMs: 45 });
  const cleanOne = populateHealthyWindow(run.createWindow("clean_1", "gate_50").open());
  const cleanTwo = populateHealthyWindow(run.createWindow("clean_2", "gate_50").open());
  const recurrence = populateHealthyWindow(run.createWindow("bad_3", "gate_50").open(), { stableLatencyMs: 10, candidateLatencyMs: 45 });
  const incidents = new IncidentStore();
  const observer = new ObserverSession("observer-incidents");
  for (const window of [badOne, badTwo, cleanOne, cleanTwo, recurrence]) {
    processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId, incidents, observer });
  }
  assert.equal(incidents.records.length, 2);
  assert.equal(incidents.records[0]?.state, "resolved");
  assert.equal(incidents.records[1]?.state, "open");
  assert.equal(incidents.records[1]?.recurrenceOf, incidents.records[0]?.incidentId);
  const replayed = IncidentStore.replay(incidents.snapshot());
  assert.deepEqual(replayed.snapshot(), incidents.snapshot());
});

test("golden 16: Observer technical retry preserves input and exhaustion fails closed", () => {
  const run = new TelemetryRunBuilder("golden_16");
  const window = populateHealthyWindow(run.createWindow("observer_retry", "gate_50").open());
  const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const assessment = assessTelemetryWindow(summary);
  const incidents = new IncidentStore();
  const observer = new ObserverSession("observer-retry");
  const input = buildObserverInput(summary, assessment, incidents, observer);
  assert.throws(() => invokeObserver(input, "attempt-1", { technicalFailure: true }), WorkerUnavailable);
  const retry = invokeObserver(input, "attempt-2");
  assert.equal(retry.inputDigest, input.inputDigest);
  assert.equal(observerUnavailableFact(input, 2).allowedEffect, "hold_or_pause_only");
});

test("golden 17: restart replay reconstructs windows, incidents, cursors, and proposals", () => {
  const run = new TelemetryRunBuilder("golden_17");
  const bad = populateHealthyWindow(run.createWindow("bad", "gate_50").open(), { stableLatencyMs: 10, candidateLatencyMs: 45 });
  const clean = populateHealthyWindow(run.createWindow("clean", "gate_50").open());

  const execute = (journal: AcceptedEventJournal) => {
    const incidents = new IncidentStore();
    const observer = new ObserverSession("observer-replay");
    const results = [bad.binding.windowId, clean.binding.windowId].map((windowId) => {
      const result = processTelemetryWindow({ journal, windowId, incidents, observer });
      return {
        windowDigest: result.summary.windowDigest,
        assessmentDigest: result.assessment.assessmentDigest,
        acceptedRecordDigest: result.accepted.acceptedRecordDigest,
        proposalDigest: result.proposal.proposalDigest
      };
    });
    return {
      results,
      incidentSnapshot: incidents.snapshot(),
      observerSnapshot: observer.snapshot()
    };
  };

  const original = execute(run.journal);
  const replayed = execute(AcceptedEventJournal.replay(run.journal.snapshot()));
  assert.deepEqual(replayed, original);
});

test("golden 18: authority, staleness, direct handoff, and illegal proposals are rejected", () => {
  const run = new TelemetryRunBuilder("golden_18");
  const window = populateHealthyWindow(run.createWindow("authority", "gate_50").open());
  const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const assessment = assessTelemetryWindow(summary);
  const incidents = new IncidentStore();
  const observer = new ObserverSession("observer-authority");
  const input = buildObserverInput(summary, assessment, incidents, observer);
  const valid = invokeObserver(input);

  const forbidden = { ...valid, action: "rollback" } as unknown as ObserverResult;
  assert.throws(() => acceptObserverResult(input, forbidden, incidents, observer), /forbidden authority field/);
  assert.throws(
    () => acceptObserverResult(input, { ...valid, sampleSequence: 99 } as ObserverResult, incidents, observer),
    /stale Observer sample sequence/
  );
  assert.throws(
    () => invokeRolloutBabysitter({
      phase: "rollout",
      summary,
      assessment,
      acceptedObserverRecord: valid as unknown as AcceptedObserverRecord
    }),
    /Orchestrator-accepted Observer record/
  );
  assert.throws(() => validateProposalForPhase("rollout", "observation_passed"), /illegal during rollout/);
});
