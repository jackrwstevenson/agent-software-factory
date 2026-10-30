import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRunStore } from "../../src/journal/file-run-store.js";
import { parseDigest, parseEffectIntentId, parseEventId, parseFactoryRunId, parseIssueId } from "../../src/protocol/contracts.js";

const inputDigest = parseDigest("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const outputDigest = parseDigest("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

test("effect intent and result records replay without synthetic lifecycle transitions", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "factory-effects-"));
  try {
    const store = new FileRunStore(runDirectory);
    let snapshot = await store.append({
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
    snapshot = await store.appendEffectIntent({
      expectedVersion: snapshot.version,
      eventId: parseEventId("evt_fixture_002"),
      recordedAt: "2026-09-28T12:00:01.000Z",
      effect: {
        effectIntentId: parseEffectIntentId("fx_fixture_001"),
        port: "RoleRuntime",
        operation: "runBuilder"
      },
      inputDigest
    });
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.state.version, 1);
    assert.equal(snapshot.effects[0]?.status, "pending");

    snapshot = await store.appendEffectResult({
      expectedVersion: snapshot.version,
      eventId: parseEventId("evt_fixture_003"),
      recordedAt: "2026-09-28T12:00:02.000Z",
      effect: {
        effectIntentId: parseEffectIntentId("fx_fixture_001"),
        port: "RoleRuntime",
        operation: "runBuilder"
      },
      outputDigest
    });
    assert.equal(snapshot.effects[0]?.status, "succeeded");
    assert.equal(snapshot.effects[0]?.outputDigest, outputDigest);

    const replayed = await new FileRunStore(runDirectory).rebuildSnapshot();
    assert.deepEqual(replayed, snapshot);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
