import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoutingRevision } from "./routing-revision.js";
import { appendNdjson, atomicWriteJson, ensurePrivateDirectory, readJsonFile } from "./runtime-files.js";
import type { ProcessAttemptRecord, ProcessRegistry, TopologySnapshot } from "./runtime-contracts.js";

export interface MutableProcessRegistry {
  schemaVersion: "1.0";
  contract: "runtime_process_registry";
  factoryRunId: string;
  startupOrder: string[];
  instances: ProcessAttemptRecord[];
  desiredRouting: RoutingRevision | null;
  routing: RoutingRevision | null;
  updatedAt: string;
}

interface SupervisorEvent {
  readonly schemaVersion: "1.0";
  readonly contract: "runtime_supervisor_event";
  readonly sequence: number;
  readonly at: string;
  readonly type: string;
  readonly factoryRunId: string;
  readonly instanceId?: string;
  readonly processAttempt?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

function now(): string {
  return new Date().toISOString();
}

export class TopologyRegistryStore {
  readonly registryPath: string;
  readonly supervisorEventsPath: string;
  readonly routingCurrentPath: string;
  readonly routingDirectory: string;
  readonly runtimeEventJournalPath: string;
  readonly instancesDirectory: string;

  constructor(
    readonly runDirectory: string,
    readonly factoryRunId: string
  ) {
    this.registryPath = join(runDirectory, "process-registry.json");
    this.supervisorEventsPath = join(runDirectory, "supervisor-events.ndjson");
    this.routingCurrentPath = join(runDirectory, "routing-current.json");
    this.routingDirectory = join(runDirectory, "routing-revisions");
    this.runtimeEventJournalPath = join(runDirectory, "runtime-events.ndjson");
    this.instancesDirectory = join(runDirectory, "instances");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.runDirectory);
    await ensurePrivateDirectory(this.instancesDirectory);
    await ensurePrivateDirectory(this.routingDirectory);
  }

  empty(): MutableProcessRegistry {
    return {
      schemaVersion: "1.0",
      contract: "runtime_process_registry",
      factoryRunId: this.factoryRunId,
      startupOrder: [],
      instances: [],
      desiredRouting: null,
      routing: null,
      updatedAt: now()
    };
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(this.registryPath, "utf8");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async load(): Promise<MutableProcessRegistry> {
    const registry = await readJsonFile<MutableProcessRegistry>(this.registryPath);
    if (registry.factoryRunId !== this.factoryRunId) throw new Error("process registry belongs to another Factory Run");
    return structuredClone(registry);
  }

  async save(registry: MutableProcessRegistry): Promise<void> {
    if (registry.factoryRunId !== this.factoryRunId) throw new Error("cannot save another Factory Run's process registry");
    registry.updatedAt = now();
    await atomicWriteJson(this.registryPath, registry satisfies ProcessRegistry);
  }

  snapshot(registry: MutableProcessRegistry): TopologySnapshot {
    return structuredClone({
      factoryRunId: registry.factoryRunId,
      startupOrder: registry.startupOrder,
      instances: registry.instances,
      desiredRouting: registry.desiredRouting,
      routing: registry.routing
    });
  }

  replaceRecord(registry: MutableProcessRegistry, record: ProcessAttemptRecord): void {
    const index = registry.instances.findIndex((item) => item.instanceId === record.instanceId);
    if (index === -1) registry.instances.push(record);
    else registry.instances[index] = record;
  }

  findRecord(registry: MutableProcessRegistry, instanceId: string): ProcessAttemptRecord | undefined {
    return registry.instances.find((item) => item.instanceId === instanceId);
  }

  requireRecord(registry: MutableProcessRegistry, instanceId: string): ProcessAttemptRecord {
    const record = this.findRecord(registry, instanceId);
    if (!record) throw new Error(`missing runtime instance ${instanceId}`);
    return record;
  }

  instanceDirectory(instanceId: string): string {
    return join(this.instancesDirectory, instanceId);
  }

  async appendSupervisorEvent(
    type: string,
    instanceId?: string,
    processAttempt?: number,
    detail?: Readonly<Record<string, unknown>>
  ): Promise<void> {
    let sequence = 1;
    try {
      sequence = (await readFile(this.supervisorEventsPath, "utf8")).split("\n").filter(Boolean).length + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const event: SupervisorEvent = {
      schemaVersion: "1.0",
      contract: "runtime_supervisor_event",
      sequence,
      at: now(),
      type,
      factoryRunId: this.factoryRunId,
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(processAttempt === undefined ? {} : { processAttempt }),
      ...(detail === undefined ? {} : { detail })
    };
    await appendNdjson(this.supervisorEventsPath, event);
  }

  async persistRoutingRevision(revision: RoutingRevision): Promise<void> {
    const immutablePath = join(
      this.routingDirectory,
      `${String(revision.revision).padStart(6, "0")}-${revision.fullFingerprint}.json`
    );
    try {
      await writeFile(immutablePath, `${JSON.stringify(revision)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readJsonFile<RoutingRevision>(immutablePath);
      if (existing.fullFingerprint !== revision.fullFingerprint) throw new Error("conflicting immutable routing revision");
    }
    await atomicWriteJson(this.routingCurrentPath, revision);
  }

  async readRoutingPointer(): Promise<RoutingRevision> {
    return readJsonFile<RoutingRevision>(this.routingCurrentPath);
  }
}
