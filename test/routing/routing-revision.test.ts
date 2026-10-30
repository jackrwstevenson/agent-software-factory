import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRoutingRevision,
  assertRoutingRevisionTransition,
  createRoutingRevision,
  workloadManifestV1,
  type RoutingRevision
} from "../../src/runtime/routing-revision.js";

function target(instanceId: "stable" | "candidate", attempt: number, port: number) {
  return {
    instanceId,
    releaseId: `${instanceId}:sha`,
    processKind: instanceId === "stable" ? "stable_release" as const : "candidate_release" as const,
    processAttempt: attempt,
    ownershipNonce: (instanceId === "stable" ? "a" : "b").repeat(48),
    pid: 41_000 + attempt,
    processBirthIdentity: `${41_000 + attempt}:Tue Sep 29 10:00:0${attempt} 2026`,
    endpoint: `http://127.0.0.1:${port}`
  };
}

function revision(number = 1, prior: RoutingRevision | null = null) {
  return createRoutingRevision({
    revision: number,
    reason: number === 1 ? "initial_stable_only" : "progressive_rollout",
    priorRevision: prior ? { revision: prior.revision, fullFingerprint: prior.fullFingerprint } : null,
    factoryRunId: "fr_runtime_test",
    rolloutSeed: "seed-01",
    stable: target("stable", 1, 41001),
    candidate: target("candidate", 2, 41002),
    candidateBasisPoints: 2_500,
    workload: workloadManifestV1()
  });
}

test("an immutable routing revision binds ownership identity, reason, prior revision, and workload", () => {
  const first = revision();
  assert.equal(first.contract, "runtime_routing_revision");
  assert.equal(first.algorithmId, "sha256-sticky-basis-points-v1");
  assert.equal(first.workload.userCount, 10_000);
  assert.equal(first.reason, "initial_stable_only");
  assert.equal(first.priorRevision, null);
  assert.equal(first.stable.ownershipNonce, "a".repeat(48));
  assert.match(first.stable.processBirthIdentity, /^41001:/);
  assert.match(first.configFingerprint, /^[0-9a-f]{64}$/);
  assert.match(first.fullFingerprint, /^[0-9a-f]{64}$/);
  const second = revision(2, first);
  assert.notEqual(first.fullFingerprint, second.fullFingerprint);
  assert.deepEqual(second.priorRevision, { revision: 1, fullFingerprint: first.fullFingerprint });
  assert.throws(() => createRoutingRevision({ ...first, candidateBasisPoints: 2_500.5 }), /integer/);
});

test("routing revision transitions reject lower, skipped, stale-prior, and conflicting identities", () => {
  const first = revision();
  const second = revision(2, first);
  assert.doesNotThrow(() => assertRoutingRevisionTransition(null, first));
  assert.doesNotThrow(() => assertRoutingRevisionTransition(first, second));
  assert.doesNotThrow(() => assertRoutingRevisionTransition(first, first));
  assert.throws(() => assertRoutingRevisionTransition(second, first), /lower routing revision/);
  assert.throws(() => assertRoutingRevisionTransition(first, revision(3, first)), /skipped routing revision/);
  assert.throws(
    () => assertRoutingRevisionTransition(first, createRoutingRevision({ ...second, priorRevision: { revision: 1, fullFingerprint: "f".repeat(64) } })),
    /prior routing revision mismatch/
  );
  assert.throws(
    () => assertRoutingRevisionTransition(first, createRoutingRevision({ ...first, reason: "conflicting_same_revision" })),
    /conflicting routing revision/
  );
});

test("routing changes are not accepted until exact full-fingerprint read-back", async () => {
  const expected = revision();
  let applied = expected;
  const accepted = await applyRoutingRevision(null, expected, {
    apply: async (value) => { applied = value; },
    readBack: async () => applied
  });
  assert.equal(accepted.fullFingerprint, expected.fullFingerprint);

  await assert.rejects(
    applyRoutingRevision(null, expected, {
      apply: async () => undefined,
      readBack: async () => revision(2, expected)
    }),
    /routing read-back fingerprint mismatch/
  );

  await assert.rejects(
    applyRoutingRevision(null, expected, {
      apply: async () => undefined,
      readBack: async () => ({
        ...expected,
        candidate: { ...expected.candidate, endpoint: "http://127.0.0.1:49999" },
        fullFingerprint: expected.fullFingerprint
      })
    }),
    /routing revision self-fingerprint mismatch/
  );
});
