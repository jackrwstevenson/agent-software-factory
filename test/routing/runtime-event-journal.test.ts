import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileRuntimeEventJournal,
  RUNTIME_EVENT_TYPES,
  RuntimeEventJournal
} from "../../src/runtime/request-journal.js";
import { createRoutingRevision, workloadManifestV1 } from "../../src/runtime/routing-revision.js";

function target(instanceId: "stable" | "candidate", attempt: number, port: number) {
  return {
    instanceId,
    releaseId: `${instanceId}:sha`,
    processAttempt: attempt,
    processKind: instanceId === "stable" ? "stable_release" as const : "candidate_release" as const,
    ownershipNonce: (instanceId === "stable" ? "a" : "b").repeat(48),
    pid: 40_000 + attempt,
    processBirthIdentity: `${40_000 + attempt}:Tue Sep 29 10:00:0${attempt} 2026`,
    endpoint: `http://127.0.0.1:${port}`
  };
}

function revision(number: number, prior: ReturnType<typeof createRoutingRevision> | null) {
  return createRoutingRevision({
    revision: number,
    reason: number === 1 ? "initial_stable_only" : "progressive_rollout",
    priorRevision: prior ? { revision: prior.revision, fullFingerprint: prior.fullFingerprint } : null,
    factoryRunId: "fr_journal_test",
    rolloutSeed: "seed",
    stable: target("stable", 1, 41001),
    candidate: target("candidate", 1, 41002),
    candidateBasisPoints: number === 1 ? 0 : 2_500,
    workload: workloadManifestV1()
  });
}

test("the globally sequenced journal replays routing, windows, and accounting and rejects unknown events", () => {
  const first = revision(1, null);
  const second = revision(2, first);
  const journal = new RuntimeEventJournal();
  journal.append({ type: "routing_change_pending", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:00.000Z", revision: first });
  journal.append({ type: "routing_change_applied", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:01.000Z", revision: first });
  journal.append({ type: "traffic_window_opened", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:02.000Z", windowId: "window-1", revision: first });
  journal.append({ type: "traffic_window_closed", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:03.000Z", windowId: "window-1", revision: first, reason: "routing_change" });
  journal.append({ type: "routing_change_pending", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:04.000Z", revision: second });
  journal.append({ type: "routing_change_applied", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:05.000Z", revision: second });
  journal.append({ type: "traffic_window_opened", factoryRunId: first.factoryRunId, at: "2026-09-29T10:00:06.000Z", windowId: "window-2", revision: second });

  const replay = new RuntimeEventJournal(journal.snapshot()).replayState();
  assert.equal(replay.desiredRouting?.fullFingerprint, second.fullFingerprint);
  assert.equal(replay.appliedRouting?.fullFingerprint, second.fullFingerprint);
  assert.deepEqual(replay.windows.map((window) => [window.windowId, window.closedAt]), [
    ["window-1", "2026-09-29T10:00:03.000Z"],
    ["window-2", null]
  ]);
  assert.deepEqual([...RUNTIME_EVENT_TYPES].sort(), [...new Set(RUNTIME_EVENT_TYPES)].sort());
  assert.throws(() => journal.append({ type: "unknown_runtime_event" } as never), /unknown runtime event type/);
  const conflictingDuplicate = journal.snapshot();
  const firstEvent = conflictingDuplicate[0];
  assert.ok(firstEvent?.type === "routing_change_pending");
  conflictingDuplicate.splice(1, 0, {
    ...firstEvent,
    revision: { ...firstEvent.revision, reason: "conflicting_nested_reason" }
  });
  assert.throws(() => new RuntimeEventJournal(conflictingDuplicate), /conflicting duplicate event sequence/);
});

test("multiple file journal handles allocate one authoritative global sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asf-global-journal-"));
  const path = join(directory, "runtime-events.ndjson");
  const first = await FileRuntimeEventJournal.open(path);
  const second = await FileRuntimeEventJournal.open(path);
  const route = revision(1, null);
  first.append({ type: "routing_change_pending", factoryRunId: route.factoryRunId, at: "2026-09-29T10:00:00.000Z", revision: route });
  second.append({ type: "routing_change_applied", factoryRunId: route.factoryRunId, at: "2026-09-29T10:00:01.000Z", revision: route });
  first.append({ type: "traffic_window_opened", factoryRunId: route.factoryRunId, at: "2026-09-29T10:00:02.000Z", windowId: "window-1", revision: route });

  const persisted = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
  assert.deepEqual(persisted.map((event) => event.sequence), [1, 2, 3]);
  assert.equal((await FileRuntimeEventJournal.open(path)).replayState().appliedRouting?.revision, 1);
});
