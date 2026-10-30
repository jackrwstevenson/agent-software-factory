import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  LocalReleaseTopology,
  TOPOLOGY_INSTANCE_IDS,
  type ProcessKind,
  type TopologyPlan
} from "../../src/runtime/local-release-topology.js";

function plan(runDirectory: string, ignoreSigtermProcessKinds: readonly ProcessKind[] = []): TopologyPlan {
  return {
    factoryRunId: "fr_topology_test",
    runDirectory,
    stableReleaseId: "stable:sha256:1111111111111111",
    candidateReleaseId: "candidate:sha256:2222222222222222",
    rolloutSeed: "topology-seed-v1",
    ignoreSigtermProcessKinds
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("five children start in production order with identity-aware readiness and isolated state", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "asf-topology-start-"));
  const topology = new LocalReleaseTopology(plan(runDirectory, ["staging_release"]), {
    startupDeadlineMs: 8_000,
    probeIntervalMs: 40,
    stopGraceMs: 150
  });
  t.after(async () => { await topology.cleanup().catch(() => undefined); });

  const snapshot = await topology.start();
  assert.deepEqual(snapshot.startupOrder, [
    TOPOLOGY_INSTANCE_IDS.stable,
    TOPOLOGY_INSTANCE_IDS.staging,
    TOPOLOGY_INSTANCE_IDS.candidate,
    TOPOLOGY_INSTANCE_IDS.router,
    TOPOLOGY_INSTANCE_IDS.traffic
  ]);
  assert.equal(snapshot.instances.length, 5);
  assert.equal(snapshot.routing?.candidateBasisPoints, 0);
  assert.equal(snapshot.routing?.stable.releaseId, "stable:sha256:1111111111111111");

  for (const instance of snapshot.instances) {
    assert.equal(instance.desiredState, "running");
    assert.equal(instance.observedState, "ready");
    assert.ok(instance.pid && isAlive(instance.pid));
    assert.ok(instance.endpoint?.startsWith("http://127.0.0.1:"));
    await access(instance.runtimeDescriptorPath);
    await access(instance.dataDirectory);
    const status = await topology.readInstanceStatus(instance.instanceId);
    assert.equal(status.factoryRunId, "fr_topology_test");
    assert.equal(status.instanceId, instance.instanceId);
    assert.equal(status.processAttempt, instance.processAttempt);
    assert.equal(status.ownershipNonce, instance.ownershipNonce);
    assert.equal(status.pid, instance.pid);
    assert.equal(status.port, Number(new URL(instance.endpoint!).port));
    assert.equal(status.lifecycleState, "ready");
  }
  assert.equal(new Set(snapshot.instances.map((instance) => instance.dataDirectory)).size, 5);

  const atTwentyFive = await topology.applyCandidateExposure(2_500);
  assert.equal(atTwentyFive.candidateBasisPoints, 2_500);
  assert.equal((await topology.readInstanceStatus(TOPOLOGY_INSTANCE_IDS.router)).details.appliedRoutingFullFingerprint, atTwentyFive.fullFingerprint);
  const candidateRecord = snapshot.instances.find((instance) => instance.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  assert.ok(candidateRecord);
  let candidateRequest: { releaseId?: string; processAttempt?: number } | undefined;
  const requestDeadline = Date.now() + 2_000;
  while (Date.now() < requestDeadline && !candidateRequest) {
    const requestText = await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8");
    candidateRequest = requestText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; target?: string; releaseId?: string; processAttempt?: number }).find((event) => event.type === "request_started" && event.target === "candidate");
    if (!candidateRequest) await delay(25);
  }
  assert.equal(candidateRequest?.releaseId, candidateRecord.releaseId);
  assert.equal(candidateRequest?.processAttempt, candidateRecord.processAttempt);

  const pids = snapshot.instances.map((instance) => instance.pid!);
  const cleanup = await topology.cleanup();
  assert.deepEqual(cleanup.escalatedInstanceIds, [TOPOLOGY_INSTANCE_IDS.staging]);
  assert.ok(pids.every((pid) => !isAlive(pid)), "a supervised process survived cleanup");

  const events = await readFile(join(runDirectory, "supervisor-events.ndjson"), "utf8");
  const runtimeEvents = await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8");
  assert.match(events, /"type":"spawn_intent"/);
  assert.match(runtimeEvents, /"type":"routing_change_applied"/);
  assert.match(events, /"type":"signal_escalated"/);
});

test("an unexpected Candidate exit verifies Stable-only routing before explicit replacement", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "asf-topology-crash-"));
  const topology = new LocalReleaseTopology(plan(runDirectory), {
    startupDeadlineMs: 8_000,
    probeIntervalMs: 40,
    stopGraceMs: 200
  });
  t.after(async () => { await topology.cleanup().catch(() => undefined); });
  await topology.start();
  await topology.applyCandidateExposure(5_000);
  const before = topology.snapshot().instances.find((item) => item.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  assert.ok(before?.pid);
  process.kill(-before.pid, "SIGKILL");

  const reconciled = await topology.reconcile();
  assert.equal(reconciled.routing?.candidateBasisPoints, 0);
  assert.equal((await topology.readInstanceStatus(TOPOLOGY_INSTANCE_IDS.traffic)).details.paused, true);
  const journalAtSafety = await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8");
  await delay(100);
  assert.equal(await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8"), journalAtSafety, "traffic continued after Candidate safety routing");
  const exited = reconciled.instances.find((item) => item.instanceId === TOPOLOGY_INSTANCE_IDS.candidate);
  assert.equal(exited?.observedState, "exited");
  const runtimeBeforeRestart = (await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; at: string; revision?: { candidateBasisPoints?: number } });
  const supervisorBeforeRestart = (await readFile(join(runDirectory, "supervisor-events.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; at: string });
  const safetyApplied = runtimeBeforeRestart.filter((event) => event.type === "routing_change_applied" && event.revision?.candidateBasisPoints === 0).at(-1);
  const candidateHandled = supervisorBeforeRestart.filter((event) => event.type === "unexpected_exit").at(-1);
  assert.ok(safetyApplied && candidateHandled && safetyApplied.at <= candidateHandled.at, "Candidate was handled before Stable-only read-back");

  const replacement = await topology.restartCandidate();
  assert.equal(replacement.processAttempt, before.processAttempt + 1);
  assert.notEqual(replacement.pid, before.pid);
  assert.notEqual(replacement.endpoint, before.endpoint);
  assert.equal(topology.snapshot().routing?.candidateBasisPoints, 0);
});

test("restart reconciliation adopts exact birth identities and refuses ambiguous processes without killing them", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "asf-topology-adopt-"));
  const owner = new LocalReleaseTopology(plan(runDirectory), {
    startupDeadlineMs: 8_000,
    probeIntervalMs: 40,
    stopGraceMs: 200
  });
  t.after(async () => { await owner.cleanup().catch(() => undefined); });
  const started = await owner.start();
  const adopter = new LocalReleaseTopology(plan(runDirectory), {
    startupDeadlineMs: 8_000,
    probeIntervalMs: 40,
    stopGraceMs: 200
  });
  const adopted = await adopter.reconcile();
  assert.deepEqual(
    adopted.instances.map((item) => [item.instanceId, item.pid, item.processBirthIdentity]),
    started.instances.map((item) => [item.instanceId, item.pid, item.processBirthIdentity])
  );

  const registryPath = join(runDirectory, "process-registry.json");
  const original = JSON.parse(await readFile(registryPath, "utf8")) as { instances: Array<{ instanceId: string; processBirthIdentity: string }> };
  const tampered = structuredClone(original);
  const stable = tampered.instances.find((item) => item.instanceId === TOPOLOGY_INSTANCE_IDS.stable);
  assert.ok(stable);
  stable.processBirthIdentity = `${stable.processBirthIdentity}-ambiguous`;
  await writeFile(registryPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  const stablePid = started.instances.find((item) => item.instanceId === TOPOLOGY_INSTANCE_IDS.stable)?.pid;
  assert.ok(stablePid);

  const ambiguous = new LocalReleaseTopology(plan(runDirectory), { startupDeadlineMs: 2_000, probeIntervalMs: 40 });
  await assert.rejects(ambiguous.reconcile(), /ambiguous process identity/);
  assert.equal(isAlive(stablePid), true, "ambiguous process was killed by PID guess");

  await writeFile(registryPath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  await adopter.cleanup();
  assert.ok(started.instances.every((item) => item.pid && !isAlive(item.pid)));
});
