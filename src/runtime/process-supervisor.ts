import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProcessChildSpec } from "./child-spec.js";
import {
  assertSameProcessAttemptIdentity,
  processAttemptIdentityFrom
} from "./process-attempt-identity.js";
import { processIsAlive, readProcessBirthIdentity } from "./process-identity.js";
import { ensurePrivateDirectory, readJsonFile } from "./runtime-files.js";
import type {
  ProcessAttemptRecord,
  ProcessKind,
  RuntimeDescriptor,
  RuntimeStatus,
  TopologyPlan
} from "./runtime-contracts.js";
import {
  TopologyRegistryStore,
  type MutableProcessRegistry
} from "./topology-registry-store.js";

export interface ProcessSupervisorOptions {
  readonly startupDeadlineMs: number;
  readonly probeIntervalMs: number;
  readonly stopGraceMs: number;
  readonly childEntrypoint: string;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fetchBounded(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(1_000) });
}

export class ProcessSupervisor {
  constructor(
    private readonly plan: TopologyPlan,
    private readonly store: TopologyRegistryStore,
    private readonly options: ProcessSupervisorOptions
  ) {}

  async startNew(
    registry: MutableProcessRegistry,
    instanceId: string,
    processKind: ProcessKind,
    releaseId: string | null,
    processAttempt = 1,
    intentKind: "spawn" | "restart" = "spawn"
  ): Promise<ProcessAttemptRecord> {
    const directory = this.store.instanceDirectory(instanceId);
    const dataDirectory = join(directory, "data");
    await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(dataDirectory);
    const record: ProcessAttemptRecord = {
      factoryRunId: this.plan.factoryRunId,
      instanceId,
      processKind,
      processAttempt,
      releaseId,
      commandDigest: sha256(JSON.stringify([process.execPath, this.options.childEntrypoint, processKind, releaseId, processAttempt])),
      desiredState: "running",
      observedState: "absent",
      pid: null,
      processGroupId: null,
      processBirthIdentity: null,
      ownershipNonce: randomBytes(24).toString("hex"),
      endpoint: null,
      runtimeDescriptorPath: join(directory, "runtime.json"),
      stdoutPath: join(directory, "stdout.ndjson"),
      stderrPath: join(directory, "stderr.log"),
      dataDirectory,
      startedAt: null,
      readyAt: null,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      expectedExit: false,
      intent: {
        kind: intentKind,
        intentId: `runtime-${intentKind}-${instanceId}-${processAttempt}`,
        recordedAt: now()
      }
    };
    this.store.replaceRecord(registry, record);
    if (!registry.startupOrder.includes(instanceId)) registry.startupOrder.push(instanceId);
    await this.store.save(registry);
    await this.store.appendSupervisorEvent("spawn_intent", instanceId, processAttempt, {
      processKind,
      releaseId,
      dataDirectory
    });
    return this.spawnRecord(registry, record);
  }

  async replaySpawn(registry: MutableProcessRegistry, input: ProcessAttemptRecord): Promise<ProcessAttemptRecord> {
    const replayIntent = input.intent;
    if (input.desiredState !== "running" || (replayIntent?.kind !== "spawn" && replayIntent?.kind !== "restart")) {
      throw new Error(`${input.instanceId} has no replayable spawn intent`);
    }
    let record = input;
    if (record.pid && processIsAlive(record.pid)) {
      if (!record.processBirthIdentity) {
        record = { ...record, processBirthIdentity: await readProcessBirthIdentity(record.pid), observedState: "starting" };
        this.store.replaceRecord(registry, record);
        await this.store.save(registry);
      }
      const descriptor = await this.waitForReadiness(record);
      const adopted = { ...record, observedState: "ready" as const, endpoint: descriptor.endpoint, readyAt: descriptor.readyAt, intent: null };
      this.store.replaceRecord(registry, adopted);
      await this.store.save(registry);
      await this.store.appendSupervisorEvent("process_adopted", adopted.instanceId, adopted.processAttempt, {
        pid: adopted.pid,
        replayedIntent: true
      });
      return adopted;
    }
    if (record.pid !== null) {
      const priorIntentId = replayIntent.intentId;
      record = {
        ...record,
        processAttempt: record.processAttempt + 1,
        ownershipNonce: randomBytes(24).toString("hex"),
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
        intent: {
          kind: "restart",
          intentId: `${priorIntentId}-attempt-${record.processAttempt + 1}`,
          recordedAt: now()
        }
      };
      this.store.replaceRecord(registry, record);
      await this.store.save(registry);
      await this.store.appendSupervisorEvent("spawn_intent_replayed", record.instanceId, record.processAttempt);
    }
    return this.spawnRecord(registry, record);
  }

  async adopt(registry: MutableProcessRegistry, record: ProcessAttemptRecord): Promise<ProcessAttemptRecord> {
    if (!record.pid || !processIsAlive(record.pid)) throw new Error(`${record.instanceId} is not live for adoption`);
    await this.verifyOwnedProcess(record, true);
    const adopted = { ...record, observedState: "ready" as const, intent: null };
    this.store.replaceRecord(registry, adopted);
    await this.store.save(registry);
    await this.store.appendSupervisorEvent("process_adopted", record.instanceId, record.processAttempt, {
      pid: record.pid,
      processBirthIdentity: record.processBirthIdentity
    });
    return adopted;
  }

  async probe(record: ProcessAttemptRecord): Promise<RuntimeStatus | null> {
    if (!record.pid || !processIsAlive(record.pid)) return null;
    await this.verifyOwnedProcess(record, false);
    if (!record.endpoint) throw new Error(`ambiguous process identity for ${record.instanceId}`);
    let response: Response;
    try {
      response = await fetchBounded(`${record.endpoint}/__factory/status`);
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const status = await response.json() as RuntimeStatus;
    assertSameProcessAttemptIdentity(
      processAttemptIdentityFrom(record),
      processAttemptIdentityFrom(status),
      `health endpoint identity for ${record.instanceId}`
    );
    if (status.port !== Number(new URL(record.endpoint).port)) throw new Error(`health endpoint port mismatch for ${record.instanceId}`);
    return status;
  }

  async readStatus(registry: MutableProcessRegistry, instanceId: string): Promise<RuntimeStatus> {
    const record = this.store.requireRecord(registry, instanceId);
    const status = await this.probe(record);
    if (!status) throw new Error(`${instanceId} is not live`);
    return status;
  }

  async stop(
    registry: MutableProcessRegistry,
    instanceId: string
  ): Promise<{ readonly stopped: boolean; readonly escalated: boolean }> {
    const record = this.store.findRecord(registry, instanceId);
    if (!record || record.observedState === "stopped") return { stopped: false, escalated: false };
    let stopping = record;
    if (stopping.desiredState !== "stopped" || stopping.intent?.kind !== "stop") {
      stopping = {
        ...stopping,
        desiredState: "stopped",
        expectedExit: true,
        intent: { kind: "stop", intentId: `runtime-stop-${instanceId}-${record.processAttempt}`, recordedAt: now() }
      };
      this.store.replaceRecord(registry, stopping);
      await this.store.save(registry);
      await this.store.appendSupervisorEvent("stop_intent", instanceId, stopping.processAttempt, { pid: stopping.pid });
    }
    if (!stopping.pid || !processIsAlive(stopping.pid)) {
      const stopped = { ...stopping, observedState: "stopped" as const, expectedExit: true, exitedAt: stopping.exitedAt ?? now(), intent: null };
      this.store.replaceRecord(registry, stopped);
      await this.store.save(registry);
      return { stopped: true, escalated: false };
    }
    await this.verifyOwnedProcess(stopping, false);
    this.signalGroup(stopping.pid, "SIGTERM");
    await this.store.appendSupervisorEvent("signal_sent", instanceId, stopping.processAttempt, { signal: "SIGTERM" });
    let escalated = false;
    const gracefulDeadline = Date.now() + this.options.stopGraceMs;
    while (Date.now() < gracefulDeadline && processIsAlive(stopping.pid)) await delay(20);
    if (processIsAlive(stopping.pid)) {
      escalated = true;
      this.signalGroup(stopping.pid, "SIGKILL");
      await this.store.appendSupervisorEvent("signal_escalated", instanceId, stopping.processAttempt, { signal: "SIGKILL" });
      const killDeadline = Date.now() + this.options.stopGraceMs;
      while (Date.now() < killDeadline && processIsAlive(stopping.pid)) await delay(20);
    }
    if (processIsAlive(stopping.pid)) throw new Error(`${instanceId} survived bounded SIGKILL cleanup`);
    const stopped: ProcessAttemptRecord = {
      ...stopping,
      desiredState: "stopped",
      observedState: "stopped",
      expectedExit: true,
      exitedAt: now(),
      exitSignal: escalated ? "SIGKILL" : "SIGTERM",
      intent: null
    };
    this.store.replaceRecord(registry, stopped);
    await this.store.save(registry);
    await this.store.appendSupervisorEvent("process_stopped", instanceId, stopping.processAttempt, { escalated });
    return { stopped: true, escalated };
  }

  async markExited(
    registry: MutableProcessRegistry,
    record: ProcessAttemptRecord,
    expectedExit = false
  ): Promise<ProcessAttemptRecord> {
    const exited = {
      ...record,
      observedState: "exited" as const,
      exitedAt: now(),
      expectedExit,
      intent: null
    };
    this.store.replaceRecord(registry, exited);
    await this.store.save(registry);
    await this.store.appendSupervisorEvent("unexpected_exit", record.instanceId, record.processAttempt, { processKind: record.processKind });
    return exited;
  }

  private async spawnRecord(registry: MutableProcessRegistry, record: ProcessAttemptRecord): Promise<ProcessAttemptRecord> {
    const childSpec = this.childSpec(registry, record);
    const stdout = await open(record.stdoutPath, "a", 0o600);
    const stderr = await open(record.stderrPath, "a", 0o600);
    let pid: number;
    try {
      const child = spawn(process.execPath, [this.options.childEntrypoint], {
        cwd: this.plan.runDirectory,
        detached: true,
        shell: false,
        env: { FACTORY_CHILD_SPEC_JSON: JSON.stringify(childSpec) },
        stdio: ["ignore", stdout.fd, stderr.fd]
      });
      if (!child.pid) throw new Error(`failed to spawn ${record.instanceId}`);
      pid = child.pid;
      child.unref();
    } finally {
      await stdout.close();
      await stderr.close();
    }
    let starting: ProcessAttemptRecord = {
      ...record,
      observedState: "starting",
      pid,
      processGroupId: pid,
      startedAt: now()
    };
    this.store.replaceRecord(registry, starting);
    await this.store.save(registry);
    await this.store.appendSupervisorEvent("process_spawned", record.instanceId, record.processAttempt, { pid, processGroupId: pid });
    starting = { ...starting, processBirthIdentity: await readProcessBirthIdentity(pid) };
    this.store.replaceRecord(registry, starting);
    await this.store.save(registry);
    const descriptor = await this.waitForReadiness(starting);
    const ready: ProcessAttemptRecord = {
      ...starting,
      observedState: "ready",
      endpoint: descriptor.endpoint,
      readyAt: descriptor.readyAt,
      intent: null
    };
    this.store.replaceRecord(registry, ready);
    await this.store.save(registry);
    await this.store.appendSupervisorEvent("process_ready", record.instanceId, record.processAttempt, { endpoint: descriptor.endpoint });
    return ready;
  }

  private childSpec(registry: MutableProcessRegistry, record: ProcessAttemptRecord): ProcessChildSpec {
    const base = {
      factoryRunId: record.factoryRunId,
      instanceId: record.instanceId,
      processAttempt: record.processAttempt,
      ownershipNonce: record.ownershipNonce,
      runtimeDescriptorPath: record.runtimeDescriptorPath,
      ignoreSigterm: this.plan.ignoreSigtermProcessKinds?.includes(record.processKind) ?? false
    } as const;
    switch (record.processKind) {
      case "stable_release":
      case "staging_release":
      case "candidate_release":
        if (!record.releaseId) throw new Error(`${record.processKind} requires releaseId`);
        return { ...base, processKind: record.processKind, releaseId: record.releaseId };
      case "router":
        return {
          ...base,
          processKind: "router",
          releaseId: null,
          routingCurrentPath: this.store.routingCurrentPath,
          runtimeEventJournalPath: this.store.runtimeEventJournalPath
        };
      case "synthetic_traffic": {
        const router = this.store.requireRecord(registry, "router");
        if (!router.endpoint) throw new Error("Router must be ready before Synthetic Traffic");
        return { ...base, processKind: "synthetic_traffic", releaseId: null, routerEndpoint: router.endpoint };
      }
    }
  }

  private async waitForReadiness(record: ProcessAttemptRecord): Promise<RuntimeDescriptor> {
    const deadline = Date.now() + this.options.startupDeadlineMs;
    let consecutive = 0;
    while (Date.now() < deadline) {
      if (!record.pid || !processIsAlive(record.pid)) throw new Error(`${record.instanceId} exited before readiness`);
      try {
        const descriptor = await readJsonFile<RuntimeDescriptor>(record.runtimeDescriptorPath);
        this.assertDescriptorIdentity(record, descriptor);
        const response = await fetchBounded(`${descriptor.endpoint}/__factory/status`);
        if (!response.ok) throw new Error(`status HTTP ${response.status}`);
        const observed = await response.json() as RuntimeStatus;
        assertSameProcessAttemptIdentity(
          processAttemptIdentityFrom(record),
          processAttemptIdentityFrom(observed),
          `health endpoint identity for ${record.instanceId}`
        );
        if (observed.port !== descriptor.port) throw new Error(`health endpoint port mismatch for ${record.instanceId}`);
        consecutive += 1;
        if (consecutive >= 2) return descriptor;
      } catch {
        consecutive = 0;
      }
      await delay(this.options.probeIntervalMs);
    }
    throw new Error(`timed out waiting for identity-aware readiness from ${record.instanceId}`);
  }

  private assertDescriptorIdentity(record: ProcessAttemptRecord, descriptor: RuntimeDescriptor): void {
    if (descriptor.contract !== "runtime_descriptor") throw new Error(`runtime descriptor contract mismatch for ${record.instanceId}`);
    assertSameProcessAttemptIdentity(
      processAttemptIdentityFrom(record),
      processAttemptIdentityFrom(descriptor),
      `runtime descriptor identity for ${record.instanceId}`
    );
  }

  private async verifyOwnedProcess(record: ProcessAttemptRecord, probeEndpoint: boolean): Promise<void> {
    if (!record.pid || !record.processBirthIdentity) throw new Error(`ambiguous process identity for ${record.instanceId}`);
    const observedBirth = await readProcessBirthIdentity(record.pid);
    if (observedBirth !== record.processBirthIdentity) throw new Error(`ambiguous process identity for ${record.instanceId}`);
    const descriptor = await readJsonFile<RuntimeDescriptor>(record.runtimeDescriptorPath);
    try {
      this.assertDescriptorIdentity(record, descriptor);
    } catch {
      throw new Error(`ambiguous process identity for ${record.instanceId}`);
    }
    if (probeEndpoint) await this.probe(record);
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
