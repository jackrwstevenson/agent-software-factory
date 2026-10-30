import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileRecordedRoleProcess,
  type ProcessGroupController,
  type ProcessInspector
} from "../../src/roles/process.js";

class FakeGroups implements ProcessGroupController {
  existsState: boolean | "ambiguous";
  readonly signals: NodeJS.Signals[] = [];

  constructor(state: boolean | "ambiguous") {
    this.existsState = state;
  }

  exists(): boolean | "ambiguous" {
    return this.existsState;
  }

  signal(_pgid: number, signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.existsState === true) this.existsState = false;
  }
}

const matchingInspector: ProcessInspector = {
  async readBirthIdentity(pid: number) {
    return `birth-${pid}`;
  }
};

test("restart reconciliation cancels a birth-identity-matched live role process", async () => {
  const groups = new FakeGroups(true);
  const outcome = await reconcileRecordedRoleProcess({
    pid: 123,
    pgid: 123,
    birthIdentity: "birth-123",
    processInspector: matchingInspector,
    processGroupController: groups,
    cancellation: { interruptGraceMs: 1, terminateGraceMs: 1, killGraceMs: 1 }
  });
  assert.equal(outcome, "cancelled");
  assert.deepEqual(groups.signals, ["SIGINT"]);
});

test("restart reconciliation adopts absence but never signals an ambiguous or birth-mismatched process", async () => {
  const absent = new FakeGroups(false);
  assert.equal(await reconcileRecordedRoleProcess({
    pid: 999,
    pgid: 999,
    birthIdentity: "birth-999",
    processInspector: { async readBirthIdentity() { return null; } },
    processGroupController: absent
  }), "absent");
  assert.deepEqual(absent.signals, []);

  const ambiguous = new FakeGroups(true);
  assert.equal(await reconcileRecordedRoleProcess({
    pid: 123,
    pgid: 123,
    birthIdentity: "different-birth",
    processInspector: matchingInspector,
    processGroupController: ambiguous
  }), "ambiguous");
  assert.deepEqual(ambiguous.signals, []);
});
