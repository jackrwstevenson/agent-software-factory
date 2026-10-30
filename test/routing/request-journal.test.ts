import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileRuntimeEventJournal, RequestJournal } from "../../src/runtime/request-journal.js";
import { ALGORITHM_ID, createRouter, createSyntheticUsers } from "../../src/runtime/routing.js";
import { UnavailableError, runLogicalRequest } from "../../src/runtime/synthetic-traffic.js";

const USERS = createSyntheticUsers();
const STABLE = "stable:sha256:1111111111111111";
const CANDIDATE = "candidate:sha256:2222222222222222";
const REQUEST_BINDING = {
  routingRevision: 7,
  routingFullFingerprint: "a".repeat(64),
  workloadVersion: "synthetic-users-v1" as const,
  workloadUsersDigest: "b".repeat(64)
};
const router = createRouter({
  algorithmId: ALGORITHM_ID,
  factoryRunId: "fr_20260928_deterministic_routing_prototype",
  rolloutSeed: "factory-run-2026-09-28-rollout-seed-01",
  stableReleaseId: STABLE,
  candidateReleaseId: CANDIDATE,
  candidateBasisPoints: 5_000
});

function usersFor(target: "stable" | "candidate", count: number): string[] {
  const users = USERS.filter((userId) => router.decide(userId).target === target).slice(0, count);
  assert.equal(users.length, count);
  return users;
}

test("bounded retries remain on one exact target and preserve prototype fault attribution", async () => {
  const journal = new RequestJournal();
  const [latencyUser, transientUser, unavailableUser] = usersFor("candidate", 3);
  const [stableUser] = usersFor("stable", 1);
  assert.ok(latencyUser && transientUser && unavailableUser && stableUser);

  const dispatch = async ({ requestId, attempt, assignment }: Parameters<typeof runLogicalRequest>[0] extends { dispatch: infer D } ? D extends (input: infer I) => unknown ? I : never : never) => {
    if (requestId === "candidate-latency") {
      await delay(35);
      return { releaseId: assignment.releaseId, processAttempt: 7, statusCode: 200 };
    }
    if (requestId === "candidate-transient-error" && attempt < 3) {
      return { releaseId: assignment.releaseId, processAttempt: 7, statusCode: 503 };
    }
    if (requestId === "candidate-unavailable") throw new UnavailableError("injected Candidate unavailability");
    return { releaseId: assignment.releaseId, processAttempt: assignment.target === "candidate" ? 7 : 3, statusCode: 200 };
  };

  const inputs = [
    ["stable-baseline", stableUser],
    ["candidate-latency", latencyUser],
    ["candidate-transient-error", transientUser],
    ["candidate-unavailable", unavailableUser]
  ] as const;
  const results = [];
  for (const [requestId, userId] of inputs) {
    results.push(await runLogicalRequest({ router, journal, requestId, userId, maxAttempts: 3, expectedProcessAttempt: router.decide(userId).target === "candidate" ? 7 : 3, binding: REQUEST_BINDING, dispatch }));
  }

  assert.deepEqual(results.map((result) => result.outcome), ["success", "success", "success", "failed"]);
  assert.deepEqual(results.map((result) => result.attempts), [1, 1, 3, 3]);
  const summary = journal.summary();
  const requestEvents = journal.events.filter((event) => "requestId" in event);
  assert.ok(requestEvents.every((event) => event.routingRevision === 7 && event.routingFullFingerprint === REQUEST_BINDING.routingFullFingerprint));
  assert.ok(requestEvents.every((event) => event.factoryRunId === router.config.factoryRunId && event.workloadVersion === "synthetic-users-v1"));
  assert.deepEqual(summary.logicalRequests, { stable: 1, candidate: 3 });
  assert.deepEqual(summary.uniqueExposedUsers, { stable: 1, candidate: 3 });
  assert.deepEqual(summary.attempts, { stable: 1, candidate: 7 });
  assert.deepEqual(summary.retries, { stable: 0, candidate: 4 });
  assert.deepEqual(summary.attemptOutcomes.candidate, { success: 2, error: 2, unavailable: 3 });
  assert.deepEqual(summary.finalOutcomes.candidate, { success: 2, failed: 1 });
  assert.ok(summary.maxObservedLatencyMs.candidate >= 34);
  assert.deepEqual(new RequestJournal(journal.snapshot()).summary(), summary);
});

test("10,000-user workload accounting replays identically", async () => {
  const quarterRouter = createRouter({ ...router.config, candidateBasisPoints: 2_500 });
  const journal = new RequestJournal();
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const userId of USERS.slice(0, 200)) {
      await runLogicalRequest({
        router: quarterRouter,
        journal,
        requestId: `workload-${cycle}-${userId}`,
        userId,
        maxAttempts: 1,
        expectedProcessAttempt: quarterRouter.decide(userId).target === "candidate" ? 7 : 3,
        binding: REQUEST_BINDING,
        dispatch: async ({ assignment }) => ({
          releaseId: assignment.releaseId,
          processAttempt: assignment.target === "candidate" ? 7 : 3,
          statusCode: 200
        })
      });
    }
  }
  const summary = journal.summary();
  assert.deepEqual(summary.logicalRequests, { stable: 300, candidate: 100 });
  assert.deepEqual(summary.uniqueExposedUsers, { stable: 150, candidate: 50 });
  assert.deepEqual(new RequestJournal(journal.snapshot()).summary(), summary);
});

test("logical request retries are policy-bounded", async () => {
  const [candidateUser] = usersFor("candidate", 1);
  assert.ok(candidateUser);
  await assert.rejects(
    runLogicalRequest({
      router,
      journal: new RequestJournal(),
      requestId: "too-many-attempts",
      userId: candidateUser,
      maxAttempts: 4,
      expectedProcessAttempt: 7,
      binding: REQUEST_BINDING,
      dispatch: async ({ assignment }) => ({ releaseId: assignment.releaseId, processAttempt: 7, statusCode: 503 })
    }),
    /at most 3/
  );
});

test("identity faults durably record protocol fault, failed attempt, and terminal negative evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asf-protocol-fault-"));
  const path = join(directory, "runtime-events.ndjson");
  const journal = await FileRuntimeEventJournal.open(path);
  const [candidateUser] = usersFor("candidate", 1);
  assert.ok(candidateUser);
  await assert.rejects(
    runLogicalRequest({
      router,
      journal,
      requestId: "durable-identity-fault",
      userId: candidateUser,
      maxAttempts: 3,
      expectedProcessAttempt: 7,
      binding: REQUEST_BINDING,
      dispatch: async () => ({ releaseId: STABLE, processAttempt: 3, statusCode: 200 })
    }),
    /release identity mismatch/
  );
  const replayed = await FileRuntimeEventJournal.open(path);
  assert.deepEqual(replayed.events.map((event) => event.type), [
    "request_started",
    "attempt_started",
    "protocol_fault",
    "attempt_finished",
    "request_finished"
  ]);
  const summary = replayed.summary();
  assert.deepEqual(summary.attempts, { stable: 0, candidate: 1 });
  assert.deepEqual(summary.protocolFaults, { stable: 0, candidate: 1 });
  assert.deepEqual(summary.attemptOutcomes.candidate, { success: 0, error: 1, unavailable: 0 });
  assert.deepEqual(summary.finalOutcomes.candidate, { success: 0, failed: 1 });
});

test("identity mismatch, sequence gaps, and conflicting duplicates fail closed", async () => {
  const [candidateUser] = usersFor("candidate", 1);
  assert.ok(candidateUser);
  await assert.rejects(
    runLogicalRequest({
      router,
      journal: new RequestJournal(),
      requestId: "identity-mismatch",
      userId: candidateUser,
      maxAttempts: 1,
      expectedProcessAttempt: 7,
      binding: REQUEST_BINDING,
      dispatch: async () => ({ releaseId: STABLE, processAttempt: 3, statusCode: 200 })
    }),
    /release identity mismatch/
  );
  await assert.rejects(
    runLogicalRequest({
      router,
      journal: new RequestJournal(),
      requestId: "process-identity-mismatch",
      userId: candidateUser,
      maxAttempts: 1,
      expectedProcessAttempt: 7,
      binding: REQUEST_BINDING,
      dispatch: async ({ assignment }) => ({ releaseId: assignment.releaseId, processAttempt: 8, statusCode: 200 })
    }),
    /process identity mismatch/
  );

  const valid = new RequestJournal();
  await runLogicalRequest({
    router,
    journal: valid,
    requestId: "valid",
    userId: candidateUser,
    maxAttempts: 1,
    expectedProcessAttempt: 7,
    binding: REQUEST_BINDING,
    dispatch: async ({ assignment }) => ({ releaseId: assignment.releaseId, processAttempt: 7, statusCode: 200 })
  });
  const gapped = valid.snapshot();
  const second = gapped[1];
  assert.ok(second);
  gapped[1] = { ...second, sequence: second.sequence + 1 };
  assert.throws(() => new RequestJournal(gapped), /global event sequence gap/);

  const duplicated = valid.snapshot();
  const first = duplicated[0];
  assert.ok(first?.type === "request_started");
  duplicated.splice(1, 0, { ...first, releaseId: "conflict" });
  assert.throws(() => new RequestJournal(duplicated), /conflicting duplicate event sequence/);
});
