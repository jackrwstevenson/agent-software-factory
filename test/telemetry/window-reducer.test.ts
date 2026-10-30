import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedEventJournal,
  ProtocolConflict,
  evaluateSufficiency,
  reduceTelemetryWindow
} from "../../src/telemetry/index.js";
import { populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

test("window reducer derives complete identity-bound metrics separately from sufficiency", () => {
  const run = new TelemetryRunBuilder("window_complete_001");
  const window = populateHealthyWindow(run.createWindow("complete", "gate_50").open(), {
    stableLatencyMs: 10,
    candidateLatencyMs: 12
  });

  const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const sufficiency = evaluateSufficiency(summary);

  assert.equal(summary.completeness, "complete");
  assert.equal(sufficiency.state, "complete_sufficient");
  assert.equal(summary.metrics.stable.logicalRequestsFinished, 48);
  assert.equal(summary.metrics.candidate.logicalRequestsFinished, 48);
  assert.equal(summary.metrics.stable.latencyP95Ms, 10);
  assert.equal(summary.metrics.candidate.latencyP95Ms, 12);
  assert.equal(summary.health.stable?.state, "healthy");
  assert.equal(summary.health.candidate?.state, "healthy");
  assert.match(summary.windowDigest, /^[0-9a-f]{64}$/);
});

test("complete evidence can remain insufficient without becoming incomplete", () => {
  const run = new TelemetryRunBuilder("window_insufficient_001");
  const window = run.createWindow("insufficient", "gate_50").open();
  window.addHealthyRequiredComponents();
  window.addRequests("stable", 2, { durationMs: 10 });
  window.addRequests("candidate", 2, { durationMs: 12 });
  window.close();

  const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const sufficiency = evaluateSufficiency(summary);
  assert.equal(summary.completeness, "complete");
  assert.equal(sufficiency.state, "complete_insufficient_samples");
  assert.equal(sufficiency.stable.finishedRequestsSatisfied, false);
  assert.equal(sufficiency.candidate.finishedRequestsSatisfied, false);
});

test("gaps, conflicting duplicates, and stale bindings fail closed as distinct evidence states", () => {
  const gapRun = new TelemetryRunBuilder("window_gap_001");
  const gap = gapRun.createWindow("gap", "gate_50").open();
  gap.addHealthyRequiredComponents();
  gap.addRequests("stable", 48);
  gap.skipTrafficSourceSequence();
  gap.addRequests("candidate", 48);
  gap.close();
  assert.equal(reduceTelemetryWindow(gapRun.journal, gap.binding.windowId).completeness, "incomplete_gap");

  const conflictRun = new TelemetryRunBuilder("window_conflict_001");
  const conflict = conflictRun.createWindow("conflict", "gate_50").open();
  conflict.addHealthyRequiredComponents();
  conflict.addRequests("stable", 48);
  conflict.addRequests("candidate", 48);
  conflict.close();
  const persisted = conflictRun.journal.snapshot().find((event) => event.eventType === "request_finished");
  assert.ok(persisted);
  assert.throws(
    () => conflictRun.journal.accept({ ...persisted, payload: { ...persisted.payload, durationMs: 999 }, payloadDigest: persisted.payloadDigest }),
    (error: unknown) => error instanceof ProtocolConflict || /payload digest mismatch/.test(String(error))
  );
  assert.equal(reduceTelemetryWindow(conflictRun.journal, conflict.binding.windowId).completeness, "invalid_conflict");

  const staleRun = new TelemetryRunBuilder("window_stale_001");
  const stale = populateHealthyWindow(staleRun.createWindow("stale", "gate_50").open());
  assert.equal(reduceTelemetryWindow(staleRun.journal, stale.binding.windowId, {
    activeCandidateReleaseId: "replacement-candidate"
  }).completeness, "stale");
});

test("window replay reproduces metrics, cursor, and digest exactly", () => {
  const run = new TelemetryRunBuilder("window_replay_001");
  const window = populateHealthyWindow(run.createWindow("replay", "gate_30").open());
  const original = reduceTelemetryWindow(run.journal, window.binding.windowId);
  const replayed = reduceTelemetryWindow(
    AcceptedEventJournal.replay(run.journal.snapshot()),
    window.binding.windowId
  );
  assert.deepEqual(replayed, original);
});

test("request protocol violations invalidate evidence without manufacturing samples", () => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    emit: (run: TelemetryRunBuilder, window: ReturnType<TelemetryRunBuilder["createWindow"]>) => void;
  }>> = [
    {
      name: "duplicate start",
      emit(run, window) {
        const selected = window.binding.components.candidate;
        assert.ok(selected);
        const payload = {
          requestId: "request-duplicate-start",
          userId: "user-1",
          operationId: "tiny-task:list",
          bucket: 1,
          selectedArm: "candidate" as const,
          selectedComponent: selected
        };
        run.emit(run.traffic, window.binding, "request_started", payload);
        run.emit(run.traffic, window.binding, "request_started", payload);
      }
    },
    {
      name: "noncontiguous attempt",
      emit(run, window) {
        const selected = window.binding.components.candidate;
        assert.ok(selected);
        run.emit(run.traffic, window.binding, "request_started", {
          requestId: "request-attempt-gap", userId: "user-1", operationId: "tiny-task:list", bucket: 1,
          selectedArm: "candidate", selectedComponent: selected
        });
        run.emit(run.traffic, window.binding, "request_attempt_finished", {
          requestId: "request-attempt-gap", attemptOrdinal: 2, selectedArm: "candidate", selectedComponent: selected,
          outcome: "success", statusCode: 200, attemptLatencyMs: 10, responseIdentityVerified: true
        });
      }
    },
    {
      name: "attempt after completion",
      emit(run, window) {
        const selected = window.binding.components.candidate;
        assert.ok(selected);
        run.emit(run.traffic, window.binding, "request_started", {
          requestId: "request-after-complete", userId: "user-1", operationId: "tiny-task:list", bucket: 1,
          selectedArm: "candidate", selectedComponent: selected
        });
        run.emit(run.traffic, window.binding, "request_attempt_finished", {
          requestId: "request-after-complete", attemptOrdinal: 1, selectedArm: "candidate", selectedComponent: selected,
          outcome: "success", statusCode: 200, attemptLatencyMs: 10, responseIdentityVerified: true
        });
        run.emit(run.traffic, window.binding, "request_finished", {
          requestId: "request-after-complete", selectedArm: "candidate", selectedComponent: selected,
          finalOutcome: "success", attemptCount: 1, durationMs: 10, failureKind: null, responseIdentityVerified: true
        });
        run.emit(run.traffic, window.binding, "request_attempt_finished", {
          requestId: "request-after-complete", attemptOrdinal: 2, selectedArm: "candidate", selectedComponent: selected,
          outcome: "success", statusCode: 200, attemptLatencyMs: 10, responseIdentityVerified: true
        });
      }
    },
    {
      name: "duplicate terminal event",
      emit(run, window) {
        const selected = window.binding.components.candidate;
        assert.ok(selected);
        run.emit(run.traffic, window.binding, "request_started", {
          requestId: "request-duplicate-terminal", userId: "user-1", operationId: "tiny-task:list", bucket: 1,
          selectedArm: "candidate", selectedComponent: selected
        });
        run.emit(run.traffic, window.binding, "request_attempt_finished", {
          requestId: "request-duplicate-terminal", attemptOrdinal: 1, selectedArm: "candidate", selectedComponent: selected,
          outcome: "success", statusCode: 200, attemptLatencyMs: 10, responseIdentityVerified: true
        });
        const terminal = {
          requestId: "request-duplicate-terminal", selectedArm: "candidate" as const, selectedComponent: selected,
          finalOutcome: "success" as const, attemptCount: 1, durationMs: 10, failureKind: null, responseIdentityVerified: true
        };
        run.emit(run.traffic, window.binding, "request_finished", terminal);
        run.emit(run.traffic, window.binding, "request_finished", terminal);
      }
    }
  ];

  for (const protocolCase of cases) {
    const run = new TelemetryRunBuilder(`protocol_${protocolCase.name.replaceAll(" ", "_")}`);
    const window = run.createWindow(`protocol_${protocolCase.name.replaceAll(" ", "_")}`, "gate_50").open();
    window.addHealthyRequiredComponents();
    protocolCase.emit(run, window);
    window.close();
    const summary = reduceTelemetryWindow(run.journal, window.binding.windowId);
    assert.equal(summary.completeness, "invalid_conflict", protocolCase.name);
    assert.ok(summary.metrics.candidate.logicalRequestsAssigned <= 1, protocolCase.name);
    assert.ok(summary.metrics.candidate.logicalRequestsFinished <= 1, protocolCase.name);
  }
});
