import assert from "node:assert/strict";
import test from "node:test";

import { LEGAL_TRANSITIONS } from "../../src/domain/factory-run.js";

test("the lifecycle transition table matches the settled Factory Run graph", () => {
  assert.deepEqual(LEGAL_TRANSITIONS, {
    building: ["verifying", "failed", "aborted", "paused_for_operator"],
    verifying: ["reviewing", "building", "failed", "aborted", "paused_for_operator"],
    reviewing: ["authorizing", "building", "failed", "aborted", "paused_for_operator"],
    authorizing: [
      "rolling_out",
      "awaiting_human_authorization",
      "rejected",
      "failed",
      "aborted",
      "paused_for_operator"
    ],
    awaiting_human_authorization: ["rolling_out", "rejected", "aborted", "paused_for_operator"],
    rolling_out: ["observing", "rolling_back", "failed", "aborted", "paused_for_operator"],
    observing: ["succeeded", "rolling_back", "paused_for_operator"],
    rolling_back: ["rolled_back", "aborted", "failed", "paused_for_operator"],
    paused_for_operator: [
      "building",
      "verifying",
      "reviewing",
      "authorizing",
      "awaiting_human_authorization",
      "rolling_out",
      "observing",
      "rolling_back",
      "aborted"
    ],
    succeeded: [],
    rejected: [],
    failed: [],
    rolled_back: [],
    aborted: []
  });
});
