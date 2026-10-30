import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ALGORITHM_ID,
  BUCKET_COUNT,
  createRouter,
  createSyntheticUsers
} from "../../src/runtime/routing.js";

const FACTORY_RUN_ID = "fr_20260928_deterministic_routing_prototype";
const FIXED_SEED = "factory-run-2026-09-28-rollout-seed-01";
const STABLE_RELEASE_ID = "stable:sha256:1111111111111111";
const CANDIDATE_RELEASE_ID = "candidate:sha256:2222222222222222";
const USERS = createSyntheticUsers();

function makeRouter(candidateBasisPoints: number, overrides: Record<string, unknown> = {}) {
  return createRouter({
    algorithmId: ALGORITHM_ID,
    factoryRunId: FACTORY_RUN_ID,
    rolloutSeed: FIXED_SEED,
    stableReleaseId: STABLE_RELEASE_ID,
    candidateReleaseId: CANDIDATE_RELEASE_ID,
    candidateBasisPoints,
    ...overrides
  });
}

function digest(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

test("sha256-sticky-basis-points-v1 reproduces the prototype golden cohorts and digests", () => {
  const expected = [
    [0, 0, "e790ea91cf95c07e680d8900013c3bab5f4d989c111e8e92d16d7c348d1f0669"],
    [100, 108, "92be9dc3006f3af3776f5c2a2111fcc55b97a23048506f72b911503201b4cca3"],
    [500, 511, "28df66443e98f88db6e364c9dd432053c754d6f740fdd21e40546821cf88e6ef"],
    [2_500, 2_457, "04f17b26f4ea2a90416d7620b80fd12811695c72c530e3f5276f3161f3f7b070"],
    [5_000, 4_949, "4aad5ecc180e5646e0350f333cf2a1a7a8f30870652d37addfcf599bffb135d4"],
    [10_000, 10_000, "474c8de76c5b4dfbfb97861bcb16b3dcbf09b18e25fc828c93042cfa1b4fa8d7"]
  ] as const;
  let previous = new Set<string>();

  for (const [basisPoints, candidateCount, expectedDigest] of expected) {
    const router = makeRouter(basisPoints);
    const candidates = new Set<string>();
    const lines = USERS.map((userId) => {
      const first = router.decide(userId);
      assert.deepEqual(router.decide(userId), first);
      assert.ok(first.bucket >= 0 && first.bucket < BUCKET_COUNT);
      if (first.target === "candidate") candidates.add(userId);
      return `${userId}:${first.bucket}:${first.target}:${first.releaseId}`;
    });
    for (const userId of previous) assert.ok(candidates.has(userId), `cohort shrank at ${basisPoints}`);
    assert.equal(candidates.size, candidateCount);
    assert.equal(digest(lines), expectedDigest);
    previous = candidates;
  }
});

test("router reconstruction is byte-identical and release replacement preserves buckets", () => {
  const before = makeRouter(2_500);
  const beforeLines = USERS.map((userId) => JSON.stringify(before.decide(userId)));
  const after = createRouter(JSON.parse(JSON.stringify(before.config)) as Parameters<typeof createRouter>[0]);
  assert.deepEqual(USERS.map((userId) => JSON.stringify(after.decide(userId))), beforeLines);
  assert.equal(after.configFingerprint, before.configFingerprint);
  assert.equal(digest(beforeLines), "d7421b5afe3e0da3c3578d1615bc6cc27dd39521326413418cbf7f65e50b0684");

  const differentSeed = makeRouter(2_500, { rolloutSeed: `${FIXED_SEED}-different` });
  const changed = USERS.filter((userId) => differentSeed.decide(userId).target !== before.decide(userId).target);
  assert.equal(changed.length, 3_751);

  const replacement = makeRouter(2_500, { candidateReleaseId: "candidate:sha256:3333333333333333" });
  for (const userId of USERS.slice(0, 100)) {
    assert.equal(replacement.decide(userId).bucket, before.decide(userId).bucket);
  }
  assert.notEqual(replacement.configFingerprint, before.configFingerprint);
});

test("routing configuration rejects ambiguity and non-integer exposure", () => {
  assert.throws(() => createRouter({} as never), /missing routing config keys/);
  assert.throws(() => makeRouter(5_000.5), /must be an integer/);
  assert.throws(() => makeRouter(BUCKET_COUNT + 1), /must be between/);
  assert.throws(() => makeRouter(5_000, { candidateReleaseId: STABLE_RELEASE_ID }), /must be different/);
  assert.throws(() => makeRouter(5_000, { unexpected: true }), /unknown routing config keys/);
});
