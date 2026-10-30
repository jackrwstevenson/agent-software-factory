import assert from "node:assert/strict";
import test from "node:test";

import {
  IncidentStore,
  ObserverSession,
  assessTelemetryWindow,
  createStableReference,
  evaluateRollbackRestoration,
  orchestratorSafetyInterlock,
  processTelemetryWindow,
  reduceTelemetryWindow
} from "../../src/telemetry/index.js";
import { createRollbackRestorationFixture, populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

test("warning latency holds, repetition rolls back, and two clean windows resolve before advance", () => {
  const run = new TelemetryRunBuilder("latency_hysteresis_001");
  const first = populateHealthyWindow(run.createWindow("latency_bad_1", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 45
  });
  const second = populateHealthyWindow(run.createWindow("latency_bad_2", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 45
  });
  const cleanOne = populateHealthyWindow(run.createWindow("latency_clean_1", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 12
  });
  const cleanTwo = populateHealthyWindow(run.createWindow("latency_clean_2", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 12
  });
  const incidents = new IncidentStore();
  const observer = new ObserverSession("observer-latency");

  const firstResult = processTelemetryWindow({ journal: run.journal, windowId: first.binding.windowId, incidents, observer });
  const secondResult = processTelemetryWindow({ journal: run.journal, windowId: second.binding.windowId, incidents, observer });
  const cleanOneResult = processTelemetryWindow({ journal: run.journal, windowId: cleanOne.binding.windowId, incidents, observer });
  const cleanTwoResult = processTelemetryWindow({ journal: run.journal, windowId: cleanTwo.binding.windowId, incidents, observer });

  assert.equal(firstResult.assessment.signals.candidateLatency, "regressed");
  assert.equal(firstResult.proposal.proposal, "hold");
  assert.equal(secondResult.proposal.proposal, "rollback");
  assert.equal(cleanOneResult.proposal.proposal, "hold");
  assert.equal(cleanTwoResult.proposal.proposal, "advance_exposure");
  assert.equal(incidents.records[0]?.state, "resolved");
});

test("severe p95 and Candidate safety facts roll back immediately even below ordinary floors", () => {
  const severeRun = new TelemetryRunBuilder("severe_latency_001");
  const severe = populateHealthyWindow(severeRun.createWindow("severe", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 600
  });
  const severeResult = processTelemetryWindow({ journal: severeRun.journal, windowId: severe.binding.windowId });
  assert.equal(severeResult.assessment.signals.candidateLatency, "breached");
  assert.equal(severeResult.proposal.proposal, "rollback");

  const failureRun = new TelemetryRunBuilder("candidate_failure_001");
  const failure = failureRun.createWindow("failure", "gate_30").open();
  failure.addHealthyRequiredComponents();
  failure.addRequests("stable", 1);
  failure.addRequest("candidate", { attemptOutcomes: ["http_error", "http_error", "http_error"], finalOutcome: "failed" });
  failure.close();
  const failureResult = processTelemetryWindow({ journal: failureRun.journal, windowId: failure.binding.windowId });
  assert.equal(failureResult.assessment.sufficiency.state, "complete_insufficient_samples");
  assert.equal(failureResult.assessment.signals.candidateError, "breached");
  assert.equal(failureResult.proposal.proposal, "rollback");
});

test("Observation requires a valid pinned Stable reference and 60 clean continuous seconds", () => {
  const run = new TelemetryRunBuilder("observation_time_001");
  const baseline = populateHealthyWindow(run.createWindow("stable_reference", "stable_reference").open(), {
    stableLatencyMs: 10
  });
  const baselineResult = processTelemetryWindow({ journal: run.journal, windowId: baseline.binding.windowId });
  const stableReference = createStableReference({
    summary: baselineResult.summary,
    assessment: baselineResult.assessment,
    acceptedObserverRecord: baselineResult.accepted
  });

  const fiftyNine = populateHealthyWindow(run.createWindow("observation_59", "observation", {
    requestedIntervalMs: 59_000,
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open(), { candidateLatencyMs: 12 });
  const sixty = populateHealthyWindow(run.createWindow("observation_60", "observation", {
    requestedIntervalMs: 60_000,
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open(), { candidateLatencyMs: 12 });

  const atFiftyNine = processTelemetryWindow({
    journal: run.journal,
    windowId: fiftyNine.binding.windowId,
    pinnedStableReference: stableReference
  });
  const atSixty = processTelemetryWindow({
    journal: run.journal,
    windowId: sixty.binding.windowId,
    pinnedStableReference: stableReference
  });
  assert.equal(atFiftyNine.proposal.proposal, "continue_observation");
  assert.equal(atSixty.proposal.proposal, "observation_passed");

  const changedRun = new TelemetryRunBuilder("observation_reference_001");
  const changed = populateHealthyWindow(changedRun.createWindow("observation_changed", "observation", {
    stableProcessAttempt: 99,
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open());
  const changedAssessment = assessTelemetryWindow(
    reduceTelemetryWindow(changedRun.journal, changed.binding.windowId),
    stableReference
  );
  assert.equal(changedAssessment.reference.state, "invalid");
});

test("bounded insufficiency holds before the deadline and pauses at the deadline", () => {
  const run = new TelemetryRunBuilder("bounded_insufficiency_001");
  const before = run.createWindow("before_deadline", "gate_5", { requestedIntervalMs: 20_000 }).open();
  before.addHealthyRequiredComponents();
  before.addRequests("stable", 5);
  before.addRequests("candidate", 5);
  before.close();
  const deadline = run.createWindow("at_deadline", "gate_5", { requestedIntervalMs: 30_000 }).open();
  deadline.addHealthyRequiredComponents();
  deadline.addRequests("stable", 5);
  deadline.addRequests("candidate", 5);
  deadline.close();

  assert.equal(processTelemetryWindow({ journal: run.journal, windowId: before.binding.windowId }).proposal.proposal, "hold");
  assert.equal(processTelemetryWindow({ journal: run.journal, windowId: deadline.binding.windowId }).proposal.proposal, "pause");
});

test("Stable loss pauses and the Orchestrator safety interlock never claims rollout authority", () => {
  const run = new TelemetryRunBuilder("stable_loss_001");
  const window = run.createWindow("stable_loss", "gate_50").open();
  window.addHealth("stable", ["unhealthy", "unhealthy", "unhealthy", ...Array.from({ length: 8 }, () => "healthy" as const)]);
  for (const component of ["candidate", "router", "traffic"] as const) {
    window.addHealth(component, Array.from({ length: 11 }, () => "healthy" as const));
  }
  window.addRequests("stable", 48);
  window.addRequests("candidate", 48);
  window.close();
  const result = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  assert.equal(result.proposal.proposal, "pause");
  assert.equal(result.assessment.conditions[0]?.conditionId, "stable.rollback_baseline_unavailable");

  const interlock = orchestratorSafetyInterlock(result.summary);
  assert.equal(interlock.lifecycleTransition, null);
});

test("rollback restoration requires exact Stable-only route, two probes, and zero later Candidate requests", () => {
  const confirmed = createRollbackRestorationFixture("rollback_confirmed", 2);
  assert.equal(evaluateRollbackRestoration({
    journal: confirmed.run.journal,
    factoryRunId: confirmed.run.factoryRunId,
    stableProcessIdentity: confirmed.stableIdentity,
    routingRevisionId: confirmed.window.binding.routingRevisionId,
    rollbackIntentAcceptedEventCursor: 0
  }).proposal, "stable_confirmed");

  const holding = createRollbackRestorationFixture("rollback_holding", 1);
  assert.equal(evaluateRollbackRestoration({
    journal: holding.run.journal,
    factoryRunId: holding.run.factoryRunId,
    stableProcessIdentity: holding.stableIdentity,
    routingRevisionId: holding.window.binding.routingRevisionId,
    rollbackIntentAcceptedEventCursor: 0
  }).proposal, "hold");

  assert.equal(evaluateRollbackRestoration({
    journal: confirmed.run.journal,
    factoryRunId: confirmed.run.factoryRunId,
    stableProcessIdentity: confirmed.stableIdentity,
    routingRevisionId: "rr_wrong",
    rollbackIntentAcceptedEventCursor: 0
  }).proposal, "pause");
});
