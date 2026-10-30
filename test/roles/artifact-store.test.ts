import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoleArtifactStore } from "../../src/roles/artifact-store.js";
import type { ProcessGroupController, ProcessInspector } from "../../src/roles/process.js";

class RecordedGroup implements ProcessGroupController {
  existsState: boolean | "ambiguous" = true;
  readonly signals: NodeJS.Signals[] = [];
  exists() { return this.existsState; }
  signal(_pgid: number, signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.existsState = false;
  }
}

const inspector: ProcessInspector = {
  async readBirthIdentity(pid) { return `birth-${pid}`; }
};

test("a pending persisted role process is birth-checked, cancelled, and durably reconciled after restart", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-role-artifacts-"));
  try {
    const store = new RoleArtifactStore(stateRoot);
    const attempt = await store.beginAttempt({
      factoryRunId: "fr_recovery_001",
      stageAttemptId: "fa_recovery_001",
      role: "verifier",
      inputSha256: "a".repeat(64),
      executablePath: "/pinned/codex",
      executableSha256: "b".repeat(64),
      model: "test-model",
      sandbox: "read-only",
      deadlineAt: "2026-09-29T12:00:00.000Z"
    });
    await store.recordLiveProcess(attempt, {
      pid: 123,
      pgid: 123,
      birth_identity: "birth-123",
      recorded_at: "2026-09-29T11:00:00.000Z"
    });

    const groups = new RecordedGroup();
    const outcomes = await store.reconcilePendingAttempts({
      processInspector: inspector,
      processGroupController: groups,
      cancellation: { interruptGraceMs: 1, terminateGraceMs: 1, killGraceMs: 1 }
    });

    assert.deepEqual(outcomes, [{
      factoryRunId: "fr_recovery_001",
      stageAttemptId: "fa_recovery_001",
      outcome: "cancelled"
    }]);
    assert.deepEqual(groups.signals, ["SIGINT"]);
    const record = JSON.parse(await readFile(join(attempt.directory, "process-reconciliation.json"), "utf8")) as { outcome: string };
    assert.equal(record.outcome, "cancelled");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
