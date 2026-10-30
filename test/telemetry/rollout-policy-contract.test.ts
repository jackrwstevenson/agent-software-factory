import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLLOUT_LADDER,
  ROLLOUT_POLICY_V1,
  gatePolicy,
  nextRolloutGate
} from "../../src/telemetry/index.js";

test("rollout-policy/v1 fixes the normative ladder, evidence floors, and deadlines", () => {
  assert.equal(ROLLOUT_POLICY_V1.policyId, "rollout-policy/v1");
  assert.equal(ROLLOUT_POLICY_V1.syntheticTraffic.logicalRequestsPerSecond, 50);
  assert.equal(ROLLOUT_POLICY_V1.syntheticTraffic.maximumInFlight, 8);
  assert.deepEqual(ROLLOUT_LADDER, [
    "staging",
    "stable_reference",
    "gate_5",
    "gate_10",
    "gate_30",
    "gate_50",
    "gate_80",
    "observation"
  ]);

  assert.deepEqual(gatePolicy("staging"), {
    gate: "staging",
    candidateBasisPoints: null,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: null,
    candidate: { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }
  });
  assert.deepEqual(gatePolicy("stable_reference"), {
    gate: "stable_reference",
    candidateBasisPoints: 0,
    minimumDurationMs: 10_000,
    collectionDeadlineMs: 30_000,
    stable: { minimumUniqueFinishedUsers: 40, minimumFinishedRequests: 80 },
    candidate: null
  });
  assert.deepEqual(
    ROLLOUT_LADDER.slice(2).map((gate) => {
      const policy = gatePolicy(gate);
      return [
        gate,
        policy.candidateBasisPoints,
        policy.minimumDurationMs,
        policy.collectionDeadlineMs,
        policy.stable,
        policy.candidate
      ];
    }),
    [
      ["gate_5", 500, 15_000, 30_000, { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }, { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }],
      ["gate_10", 1_000, 10_000, 30_000, { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }, { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }],
      ["gate_30", 3_000, 10_000, 30_000, { minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 }, { minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 }],
      ["gate_50", 5_000, 10_000, 30_000, { minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 }, { minimumUniqueFinishedUsers: 24, minimumFinishedRequests: 48 }],
      ["gate_80", 8_000, 15_000, 30_000, { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }, { minimumUniqueFinishedUsers: 20, minimumFinishedRequests: 40 }],
      ["observation", 10_000, 60_000, 90_000, null, { minimumUniqueFinishedUsers: 100, minimumFinishedRequests: 240 }]
    ]
  );
});

test("rollout-policy/v1 refuses ladder skips", () => {
  assert.equal(nextRolloutGate("staging"), "stable_reference");
  assert.equal(nextRolloutGate("gate_30"), "gate_50");
  assert.equal(nextRolloutGate("observation"), null);
  assert.throws(() => nextRolloutGate("gate_10", "gate_50"), /cannot skip/);
});
