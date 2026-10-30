import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LocalReleaseTopology, TOPOLOGY_INSTANCE_IDS } from "../../src/runtime/local-release-topology.js";
import { TopologyRegistryStore } from "../../src/runtime/topology-registry-store.js";
import { FileRuntimeEventJournal } from "../../src/runtime/request-journal.js";
import { createRoutingRevision, workloadManifestV1 } from "../../src/runtime/routing-revision.js";

function plan(runDirectory: string) {
  return {
    factoryRunId: "fr_recovery_test",
    runDirectory,
    stableReleaseId: "stable:sha",
    candidateReleaseId: "candidate:sha",
    rolloutSeed: "recovery-seed"
  } as const;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(description: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("active liveness supervision immediately safety-routes an exited Candidate", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "asf-active-liveness-"));
  const topology = new LocalReleaseTopology(plan(runDirectory), {
    startupDeadlineMs: 8_000,
    probeIntervalMs: 40,
    livenessIntervalMs: 40,
    stopGraceMs: 200
  });
  t.after(async () => { await topology.cleanup().catch(() => undefined); });
  await topology.start();
  await topology.applyCandidateExposure(5_000);
  const candidate = topology.snapshot().instances.find((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  assert.ok(candidate?.pid);
  process.kill(-candidate.pid, "SIGKILL");

  await waitUntil("active Candidate response", () => {
    const snapshot = topology.snapshot();
    return snapshot.routing?.candidateBasisPoints === 0
      && snapshot.instances.find((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.candidate)?.observedState === "exited";
  });
  assert.equal((await topology.readInstanceStatus(TOPOLOGY_INSTANCE_IDS.traffic)).details.paused, true);
});

test("required Stable, Router, and Synthetic Traffic liveness losses receive immediate fail-closed responses", async (t) => {
  for (const instanceId of [TOPOLOGY_INSTANCE_IDS.stable, TOPOLOGY_INSTANCE_IDS.router, TOPOLOGY_INSTANCE_IDS.traffic]) {
    await t.test(instanceId, async (subtest) => {
      const runDirectory = await mkdtemp(join(tmpdir(), `asf-required-${instanceId}-`));
      const topology = new LocalReleaseTopology(plan(runDirectory), {
        startupDeadlineMs: 8_000,
        probeIntervalMs: 40,
        livenessIntervalMs: 0,
        stopGraceMs: 200
      });
      subtest.after(async () => { await topology.cleanup().catch(() => undefined); });
      await topology.start();
      const record = topology.snapshot().instances.find((item) => item.instanceId === instanceId);
      assert.ok(record?.pid);
      process.kill(-record.pid, "SIGKILL");
      await waitUntil(`${instanceId} exit`, () => !alive(record.pid!));
      const responses = await topology.superviseOnce();
      assert.ok(responses.some((response) => response.instanceId === instanceId));
      assert.equal(topology.snapshot().instances.find((item) => item.instanceId === instanceId)?.observedState, "exited");
      const replay = (await FileRuntimeEventJournal.open(join(runDirectory, "runtime-events.ndjson"))).replayState();
      assert.equal(replay.windows.at(-1)?.closeReason, "interrupted");
      if (instanceId !== TOPOLOGY_INSTANCE_IDS.traffic) {
        assert.equal((await topology.readInstanceStatus(TOPOLOGY_INSTANCE_IDS.traffic)).details.paused, true);
      }
    });
  }
});

test("restart reconciliation replays incomplete spawn, stop, and desired routing intents", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "asf-intent-replay-"));
  const topology = new LocalReleaseTopology(plan(runDirectory), {
    startupDeadlineMs: 8_000,
    probeIntervalMs: 40,
    livenessIntervalMs: 0,
    stopGraceMs: 200
  });
  t.after(async () => { await topology.cleanup().catch(() => undefined); });
  await topology.start();
  const store = new TopologyRegistryStore(runDirectory, plan(runDirectory).factoryRunId);
  await store.initialize();

  let registry = await store.load();
  const candidateIndex = registry.instances.findIndex((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  const candidate = registry.instances[candidateIndex];
  assert.ok(candidate?.pid);
  process.kill(-candidate.pid, "SIGKILL");
  await waitUntil("Candidate exit before replay", () => !alive(candidate.pid!));
  const replayAttempt = candidate.processAttempt + 1;
  registry.instances[candidateIndex] = {
    ...candidate,
    processAttempt: replayAttempt,
    ownershipNonce: randomBytes(24).toString("hex"),
    desiredState: "running",
    observedState: "absent",
    pid: null,
    processGroupId: null,
    processBirthIdentity: null,
    endpoint: null,
    startedAt: null,
    readyAt: null,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    expectedExit: false,
    intent: { kind: "restart", intentId: "restart-candidate-replay", recordedAt: "2026-09-29T10:00:00.000Z" }
  };
  await store.save(registry);
  let reconciled = await topology.reconcile();
  const replayedCandidate = reconciled.instances.find((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  assert.equal(replayedCandidate?.processAttempt, replayAttempt);
  assert.equal(replayedCandidate?.observedState, "ready");
  assert.ok(replayedCandidate?.pid && alive(replayedCandidate.pid));

  registry = await store.load();
  const prior = registry.routing;
  assert.ok(prior);
  const stable = registry.instances.find((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.stable);
  const routedCandidate = registry.instances.find((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  assert.ok(stable?.endpoint && routedCandidate?.endpoint && stable.pid && routedCandidate.pid && stable.processBirthIdentity && routedCandidate.processBirthIdentity);
  const desired = createRoutingRevision({
    revision: prior.revision + 1,
    reason: "replay_pending_routing",
    priorRevision: { revision: prior.revision, fullFingerprint: prior.fullFingerprint },
    factoryRunId: registry.factoryRunId,
    rolloutSeed: plan(runDirectory).rolloutSeed,
    stable: {
      instanceId: stable.instanceId,
      releaseId: stable.releaseId!,
      processKind: "stable_release",
      processAttempt: stable.processAttempt,
      ownershipNonce: stable.ownershipNonce,
      pid: stable.pid,
      processBirthIdentity: stable.processBirthIdentity,
      endpoint: stable.endpoint
    },
    candidate: {
      instanceId: routedCandidate.instanceId,
      releaseId: routedCandidate.releaseId!,
      processKind: "candidate_release",
      processAttempt: routedCandidate.processAttempt,
      ownershipNonce: routedCandidate.ownershipNonce,
      pid: routedCandidate.pid,
      processBirthIdentity: routedCandidate.processBirthIdentity,
      endpoint: routedCandidate.endpoint
    },
    candidateBasisPoints: 2_500,
    workload: workloadManifestV1()
  });
  registry.desiredRouting = desired;
  await store.save(registry);
  reconciled = await topology.reconcile();
  assert.equal(reconciled.routing?.fullFingerprint, desired.fullFingerprint);
  assert.equal(reconciled.desiredRouting?.fullFingerprint, desired.fullFingerprint);

  registry = await store.load();
  const trafficIndex = registry.instances.findIndex((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.traffic);
  const traffic = registry.instances[trafficIndex];
  assert.ok(traffic?.pid);
  registry.instances[trafficIndex] = {
    ...traffic,
    desiredState: "stopped",
    intent: { kind: "stop", intentId: "stop-traffic-replay", recordedAt: "2026-09-29T10:01:00.000Z" }
  };
  await store.save(registry);
  reconciled = await topology.reconcile();
  assert.equal(reconciled.instances.find((record) => record.instanceId === TOPOLOGY_INSTANCE_IDS.traffic)?.observedState, "stopped");
  assert.equal(alive(traffic.pid), false);

  const runtimeEvents = await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8");
  assert.match(runtimeEvents, /"type":"routing_change_pending"/);
  assert.match(runtimeEvents, /"type":"routing_change_applied"/);
});
