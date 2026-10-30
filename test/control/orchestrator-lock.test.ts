import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileOrchestratorLock } from "../../src/orchestrator/file-lock.js";

test("the state root admits only one active Orchestrator", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-lock-"));
  try {
    const first = await FileOrchestratorLock.acquire(join(stateRoot, "lock"));
    await assert.rejects(
      FileOrchestratorLock.acquire(join(stateRoot, "lock")),
      /orchestrator_conflict/
    );
    await first.release();
    const replacement = await FileOrchestratorLock.acquire(join(stateRoot, "lock"));
    await replacement.release();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("a crashed local Orchestrator leaves a recoverable stale lock", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-stale-lock-"));
  try {
    const lockPath = join(stateRoot, "lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: "1.0",
        contract: "orchestrator_lock",
        token: "00000000-0000-4000-8000-000000000000",
        pid: 99999999,
        hostname: hostname(),
        acquiredAt: "2026-09-28T12:00:00.000Z"
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    const replacement = await FileOrchestratorLock.acquire(lockPath);
    await replacement.release();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
