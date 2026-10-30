import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRunStore } from "../../src/journal/file-run-store.js";
import { createFixtureAdapters } from "../../src/orchestrator/fakes.js";
import { runOnceFixture } from "../../src/orchestrator/run-once.js";
import { validateProtocol } from "../../src/protocol/schemas.js";

test("every persisted fixture event and snapshot validates against its v1 schema", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-contract-"));
  try {
    const runDirectory = join(stateRoot, "runs", "fr_fixture_001");
    await runOnceFixture({
      store: new FileRunStore(runDirectory),
      ...createFixtureAdapters().adapters
    });

    const eventLines = (await readFile(join(runDirectory, "run-events.ndjson"), "utf8"))
      .trimEnd()
      .split("\n");
    for (const line of eventLines) {
      const validation = validateProtocol("run-event", JSON.parse(line));
      assert.equal(validation.ok, true, validation.ok ? undefined : validation.errors.join("\n"));
    }

    const snapshot = JSON.parse(await readFile(join(runDirectory, "run-snapshot.json"), "utf8"));
    const validation = validateProtocol("run-snapshot", snapshot);
    assert.equal(validation.ok, true, validation.ok ? undefined : validation.errors.join("\n"));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
