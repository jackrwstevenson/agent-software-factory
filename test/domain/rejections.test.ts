import assert from "node:assert/strict";
import test from "node:test";

import { applyFactoryRunCommand } from "../../src/domain/factory-run.js";
import { parseFactoryRunId, parseIssueId } from "../../src/protocol/contracts.js";

const created = applyFactoryRunCommand(null, {
  kind: "create_run",
  authority: "orchestrator",
  factoryRunId: parseFactoryRunId("fr_fixture_001"),
  issueId: parseIssueId("fixture")
});
assert.equal(created.ok, true);
const building = created.state;

test("the reducer rejects skipped Stages and direct worker authority", () => {
  const skipped = applyFactoryRunCommand(building, {
    kind: "transition",
    authority: "orchestrator",
    to: "reviewing",
    reason: "skip Verify",
    evidence: {}
  });
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.equal(skipped.error.code, "ILLEGAL_TRANSITION");

  for (const authority of ["observer", "rollout_babysitter"] as const) {
    const result = applyFactoryRunCommand(building, {
      kind: "transition",
      authority,
      to: "failed",
      reason: "worker attempted a direct lifecycle mutation",
      evidence: {
        failure: { reason: "worker claim", candidateExposureBasisPoints: 0 }
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "WORKER_AUTHORITY_VIOLATION");
  }
});

test("Terminal Outcomes are immutable", () => {
  const failed = applyFactoryRunCommand(building, {
    kind: "transition",
    authority: "orchestrator",
    to: "failed",
    reason: "unrecoverable Build failure",
    evidence: {
      failure: { reason: "attempt budget exhausted", candidateExposureBasisPoints: 0 }
    }
  });
  assert.equal(failed.ok, true);

  const reopened = applyFactoryRunCommand(failed.state, {
    kind: "transition",
    authority: "orchestrator",
    to: "building",
    reason: "try to reopen",
    evidence: {}
  });
  assert.equal(reopened.ok, false);
  if (!reopened.ok) assert.equal(reopened.error.code, "TERMINAL_OUTCOME_IMMUTABLE");
});
