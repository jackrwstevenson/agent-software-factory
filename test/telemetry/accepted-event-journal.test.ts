import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedEventJournal,
  ProtocolConflict,
  createTelemetryEvent,
  type TelemetryEventOf
} from "../../src/telemetry/index.js";

type ProtocolFaultEvent = TelemetryEventOf<"protocol_fault">;

function event(overrides: Partial<ProtocolFaultEvent> = {}): ProtocolFaultEvent {
  return createTelemetryEvent({
    eventId: "te_journal_001",
    factoryRunId: "fr_telemetry_001",
    occurredAt: "2026-09-29T09:00:00.000Z",
    monotonicMs: 0,
    source: {
      kind: "orchestrator",
      instanceId: "orchestrator-1",
      processAttempt: "attempt-1",
      sourceSequence: 1
    },
    windowId: "tw_journal_001",
    eventType: "protocol_fault",
    binding: {
      topologyEpoch: 1,
      routingRevisionId: "rr_001",
      routingConfigFingerprint: "a".repeat(64),
      phase: "rollout",
      gate: "gate_50",
      candidateBasisPoints: 5_000,
      stableReleaseId: "stable-release",
      candidateReleaseId: "candidate-release",
      workloadId: "synthetic-traffic/v1",
      workloadDigest: "b".repeat(64),
      policyId: "rollout-policy/v1"
    },
    payload: { condition: "example" },
    ...overrides
  });
}

test("accepted event journal adopts exact duplicates and rejects conflicting identities", () => {
  const journal = new AcceptedEventJournal("fr_telemetry_001");
  const first = journal.accept(event());
  const duplicate = journal.accept(event());

  assert.equal(first.duplicate, false);
  assert.equal(first.event.ingestSequence, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(journal.snapshot().length, 1);

  assert.throws(
    () => journal.accept(event({ payload: { condition: "changed" } })),
    (error: unknown) => error instanceof ProtocolConflict
  );
  assert.equal(journal.conflictsForWindow("tw_journal_001").length, 1);
});

test("accepted event journal replay preserves exact events and digest", () => {
  const journal = new AcceptedEventJournal("fr_telemetry_001");
  journal.accept(event());
  journal.accept(event({
    eventId: "te_journal_002",
    source: {
      kind: "orchestrator",
      instanceId: "orchestrator-1",
      processAttempt: "attempt-1",
      sourceSequence: 2
    },
    monotonicMs: 1
  }));

  const replayed = AcceptedEventJournal.replay(journal.snapshot());
  assert.deepEqual(replayed.snapshot(), journal.snapshot());
  assert.equal(replayed.digest(), journal.digest());

  const gapped = journal.snapshot().map((accepted, index) => index === 1
    ? { ...accepted, ingestSequence: 3 }
    : accepted);
  assert.throws(() => AcceptedEventJournal.replay(gapped), /ingest sequence gap/);
});

test("journal checkpoints preserve protocol conflicts so restart cannot rehabilitate invalid evidence", () => {
  const journal = new AcceptedEventJournal("fr_telemetry_001");
  const accepted = journal.accept(event()).event;
  assert.throws(
    () => journal.accept({
      ...accepted,
      payload: { condition: "conflict-after-accept" },
      payloadDigest: accepted.payloadDigest
    }),
    ProtocolConflict
  );

  const checkpoint = journal.checkpoint();
  const replayed = AcceptedEventJournal.replayCheckpoint(checkpoint);
  assert.deepEqual(replayed.conflictsForWindow("tw_journal_001"), journal.conflictsForWindow("tw_journal_001"));
  assert.equal(replayed.digest(), journal.digest());
});
