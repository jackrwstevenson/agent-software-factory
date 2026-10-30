import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileRunStore,
  JournalError,
  replayRunEvents,
  type RunEvent
} from "../../src/journal/file-run-store.js";
import { parseDigest, parseEffectIntentId, parseEventId, parseFactoryRunId, parseIssueId } from "../../src/protocol/contracts.js";

test("the journal rejects optimistic conflicts, sequence gaps, and digest tampering", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "factory-replay-rejection-"));
  try {
    const store = new FileRunStore(runDirectory);
    await store.append({
      expectedVersion: 0,
      eventId: parseEventId("evt_fixture_001"),
      recordedAt: "2026-09-28T12:00:00.000Z",
      command: {
        kind: "create_run",
        authority: "orchestrator",
        factoryRunId: parseFactoryRunId("fr_fixture_001"),
        issueId: parseIssueId("fixture")
      }
    });

    await assert.rejects(
      store.appendEffectIntent({
        expectedVersion: 0,
        eventId: parseEventId("evt_fixture_conflict"),
        recordedAt: "2026-09-28T12:00:01.000Z",
        effect: {
          effectIntentId: parseEffectIntentId("fx_fixture_001"),
          port: "RoleRuntime",
          operation: "runBuilder"
        },
        inputDigest: parseDigest("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      }),
      (error: unknown) => error instanceof JournalError && error.code === "EXPECTED_VERSION_MISMATCH"
    );

    const [event] = (await readFile(join(runDirectory, "run-events.ndjson"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent);
    assert.notEqual(event, undefined);

    assert.throws(
      () => replayRunEvents([{ ...(event as RunEvent), sequence: 2 }]),
      (error: unknown) => error instanceof JournalError && error.code === "SEQUENCE_GAP"
    );

    const original = event as RunEvent;
    assert.equal(original.record.kind, "lifecycle_command");
    if (original.record.kind !== "lifecycle_command") throw new Error("fixture event mismatch");
    const tampered: RunEvent = {
      ...original,
      record: {
        kind: "lifecycle_command",
        command: { ...original.record.command, issueId: "tampered" }
      }
    } as RunEvent;
    assert.throws(
      () => replayRunEvents([tampered]),
      (error: unknown) => error instanceof JournalError && error.code === "DIGEST_MISMATCH"
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
