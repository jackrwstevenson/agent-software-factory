import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../../src/protocol/canonical-json.js";
import {
  ObserverSession,
  createStableReference,
  processTelemetryWindow,
  type StableReference
} from "../../src/telemetry/index.js";
import { populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

test("Observation re-reduces the durable Stable source window and rejects a consistently rewritten reference", () => {
  const run = new TelemetryRunBuilder("stable_reference_tamper_001");
  const baseline = populateHealthyWindow(run.createWindow("tamper_baseline", "stable_reference").open(), {
    stableLatencyMs: 10
  });
  const baselineResult = processTelemetryWindow({ journal: run.journal, windowId: baseline.binding.windowId });
  const reference = createStableReference({
    summary: baselineResult.summary,
    assessment: baselineResult.assessment,
    acceptedObserverRecord: baselineResult.accepted
  });
  const { referenceDigest: _referenceDigest, ...referenceCore } = reference;
  const rewrittenCore = {
    ...referenceCore,
    metrics: { ...reference.metrics, latencyP95Ms: 1 }
  };
  const rewritten = Object.freeze({
    ...rewrittenCore,
    referenceDigest: canonicalSha256(rewrittenCore)
  }) as StableReference;

  const observation = populateHealthyWindow(run.createWindow("tamper_observation", "observation", {
    pinnedStableReferenceWindowId: baseline.binding.windowId
  }).open());
  const result = processTelemetryWindow({
    journal: run.journal,
    windowId: observation.binding.windowId,
    pinnedStableReference: rewritten
  });

  assert.equal(result.assessment.reference.state, "invalid");
  assert.ok(result.assessment.reference.reasons.includes("source_metrics_mismatch"));
  assert.equal(result.proposal.proposal, "pause");
});

test("ObserverSession snapshots deeply copy and freeze accepted records", () => {
  const run = new TelemetryRunBuilder("observer_snapshot_freeze_001");
  const window = populateHealthyWindow(run.createWindow("observer_snapshot", "gate_50").open());
  const session = new ObserverSession("observer-snapshot-freeze");
  processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId, observer: session });

  const snapshot = session.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.acceptedRecords), true);
  assert.equal(Object.isFrozen(snapshot.acceptedRecords[0]), true);
  assert.equal(Object.isFrozen(snapshot.acceptedRecords[0]?.openIncidents), true);
  assert.throws(() => {
    (snapshot.acceptedRecords as unknown as unknown[]).push({});
  }, TypeError);

  assert.deepEqual(session.snapshot(), snapshot);
});
