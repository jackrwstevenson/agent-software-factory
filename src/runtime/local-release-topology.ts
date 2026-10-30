import { fileURLToPath } from "node:url";
import { ProcessSupervisor, type ProcessSupervisorOptions } from "./process-supervisor.js";
import { processIsAlive } from "./process-identity.js";
import { RoutingCoordinator } from "./routing-coordinator.js";
import type { RoutingRevision } from "./routing-revision.js";
import {
  TopologyRegistryStore,
  type MutableProcessRegistry
} from "./topology-registry-store.js";
import type {
  CleanupResult,
  LivenessResponse,
  ProcessAttemptRecord,
  RuntimeStatus,
  TopologyOptions,
  TopologyPlan,
  TopologySnapshot
} from "./runtime-contracts.js";

export type {
  CleanupResult,
  LivenessResponse,
  ProcessAttemptRecord,
  ProcessKind,
  RuntimeStatus,
  TopologyOptions,
  TopologyPlan,
  TopologySnapshot
} from "./runtime-contracts.js";

export const TOPOLOGY_INSTANCE_IDS = Object.freeze({
  stable: "stable",
  staging: "staging",
  candidate: "candidate",
  router: "router",
  traffic: "synthetic-traffic"
});

const PROCESS_ORDER = [
  TOPOLOGY_INSTANCE_IDS.stable,
  TOPOLOGY_INSTANCE_IDS.staging,
  TOPOLOGY_INSTANCE_IDS.candidate,
  TOPOLOGY_INSTANCE_IDS.router,
  TOPOLOGY_INSTANCE_IDS.traffic
] as const;

const REQUIRED_LIVENESS = [
  TOPOLOGY_INSTANCE_IDS.stable,
  TOPOLOGY_INSTANCE_IDS.router,
  TOPOLOGY_INSTANCE_IDS.traffic,
  TOPOLOGY_INSTANCE_IDS.candidate
] as const;

interface ResolvedOptions extends ProcessSupervisorOptions {
  readonly livenessIntervalMs: number;
}

export class LocalReleaseTopology {
  private readonly store: TopologyRegistryStore;
  private readonly supervisor: ProcessSupervisor;
  private readonly routing: RoutingCoordinator;
  private readonly options: ResolvedOptions;
  private registry: MutableProcessRegistry;
  private livenessTimer: NodeJS.Timeout | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly plan: TopologyPlan, options: TopologyOptions = {}) {
    this.options = {
      startupDeadlineMs: options.startupDeadlineMs ?? 15_000,
      probeIntervalMs: options.probeIntervalMs ?? 250,
      livenessIntervalMs: options.livenessIntervalMs ?? 1_000,
      stopGraceMs: options.stopGraceMs ?? 1_000,
      childEntrypoint: options.childEntrypoint ?? fileURLToPath(new URL("./child-process.js", import.meta.url))
    };
    this.store = new TopologyRegistryStore(plan.runDirectory, plan.factoryRunId);
    this.registry = this.store.empty();
    this.supervisor = new ProcessSupervisor(plan, this.store, this.options);
    this.routing = new RoutingCoordinator(this.store, this.supervisor, {
      startupDeadlineMs: this.options.startupDeadlineMs,
      probeIntervalMs: this.options.probeIntervalMs,
      rolloutSeed: plan.rolloutSeed
    });
  }

  snapshot(): TopologySnapshot {
    return this.store.snapshot(this.registry);
  }

  async start(): Promise<TopologySnapshot> {
    return this.enqueue(async () => {
      this.stopLivenessMonitor();
      await this.store.initialize();
      if (await this.store.exists()) {
        const reconciled = await this.reconcileInternal();
        this.startLivenessMonitor();
        return reconciled;
      }
      this.registry = this.store.empty();
      await this.store.save(this.registry);

      await this.supervisor.startNew(this.registry, TOPOLOGY_INSTANCE_IDS.stable, "stable_release", this.plan.stableReleaseId);
      await this.supervisor.startNew(this.registry, TOPOLOGY_INSTANCE_IDS.staging, "staging_release", this.plan.candidateReleaseId);
      await this.supervisor.startNew(this.registry, TOPOLOGY_INSTANCE_IDS.candidate, "candidate_release", this.plan.candidateReleaseId);

      const initial = this.routing.createRevision(this.registry, 0, "initial_stable_only");
      await this.routing.recordDesired(this.registry, initial);
      await this.supervisor.startNew(this.registry, TOPOLOGY_INSTANCE_IDS.router, "router", null);
      await this.routing.reconcile(this.registry, false);
      await this.supervisor.startNew(this.registry, TOPOLOGY_INSTANCE_IDS.traffic, "synthetic_traffic", null);
      await this.assertRequiredLiveness(this.registry);
      this.startLivenessMonitor();
      return this.snapshot();
    });
  }

  async reconcile(): Promise<TopologySnapshot> {
    return this.enqueue(async () => {
      this.stopLivenessMonitor();
      const result = await this.reconcileInternal();
      this.startLivenessMonitor();
      return result;
    });
  }

  async applyCandidateExposure(candidateBasisPoints: number, reason = "progressive_rollout", resumeTraffic = true): Promise<RoutingRevision> {
    return this.enqueue(async () => {
      this.registry = await this.store.load();
      const candidate = this.store.requireRecord(this.registry, TOPOLOGY_INSTANCE_IDS.candidate);
      if (candidateBasisPoints > 0 && candidate.observedState !== "ready") throw new Error("Candidate must be ready before receiving traffic");
      const revision = this.routing.createRevision(this.registry, candidateBasisPoints, reason);
      await this.routing.apply(this.registry, revision, resumeTraffic);
      return revision;
    });
  }

  async restartCandidate(): Promise<ProcessAttemptRecord> {
    return this.enqueue(async () => {
      this.registry = await this.store.load();
      const current = this.store.requireRecord(this.registry, TOPOLOGY_INSTANCE_IDS.candidate);
      if (this.registry.routing?.candidateBasisPoints !== 0) throw new Error("Candidate restart requires verified Stable-only routing");
      if (current.observedState !== "exited" && current.observedState !== "stopped") {
        throw new Error("Candidate restart requires an exited Process Attempt");
      }
      const replacement = await this.supervisor.startNew(
        this.registry,
        TOPOLOGY_INSTANCE_IDS.candidate,
        "candidate_release",
        this.plan.candidateReleaseId,
        current.processAttempt + 1,
        "restart"
      );
      const revision = this.routing.createRevision(this.registry, 0, "candidate_replacement_bound");
      await this.routing.apply(this.registry, revision, true);
      return replacement;
    });
  }

  async superviseOnce(): Promise<readonly LivenessResponse[]> {
    return this.enqueue(() => this.superviseOnceInternal());
  }

  async readInstanceStatus(instanceId: string): Promise<RuntimeStatus> {
    const registry = await this.store.load();
    return this.supervisor.readStatus(registry, instanceId);
  }

  async cleanup(): Promise<CleanupResult> {
    this.stopLivenessMonitor();
    return this.enqueue(async () => {
      await this.store.initialize();
      if (!(await this.store.exists())) return { escalatedInstanceIds: [], stoppedInstanceIds: [] };
      this.registry = await this.store.load();
      const router = this.store.findRecord(this.registry, TOPOLOGY_INSTANCE_IDS.router);
      const traffic = this.store.findRecord(this.registry, TOPOLOGY_INSTANCE_IDS.traffic);
      if (
        router?.observedState === "ready"
        && traffic?.observedState === "ready"
        && this.registry.routing
        && this.registry.routing.candidateBasisPoints !== 0
      ) {
        const safety = this.routing.createRevision(this.registry, 0, "terminal_cleanup_safety");
        await this.routing.apply(this.registry, safety, false);
      } else if (traffic?.observedState === "ready") {
        await this.routing.setTrafficPaused(this.registry, true).catch(() => undefined);
      }
      await this.routing.closeOpenWindow("shutdown").catch(() => undefined);

      const escalated: string[] = [];
      const stopped: string[] = [];
      for (const instanceId of [
        TOPOLOGY_INSTANCE_IDS.traffic,
        TOPOLOGY_INSTANCE_IDS.candidate,
        TOPOLOGY_INSTANCE_IDS.staging,
        TOPOLOGY_INSTANCE_IDS.router,
        TOPOLOGY_INSTANCE_IDS.stable
      ]) {
        const result = await this.supervisor.stop(this.registry, instanceId);
        if (result.stopped) stopped.push(instanceId);
        if (result.escalated) escalated.push(instanceId);
      }
      return { escalatedInstanceIds: escalated, stoppedInstanceIds: stopped };
    });
  }

  private async reconcileInternal(): Promise<TopologySnapshot> {
    await this.store.initialize();
    this.registry = await this.store.load();

    for (const instanceId of PROCESS_ORDER) {
      let record = this.store.findRecord(this.registry, instanceId);
      if (!record) continue;
      if (record.desiredState === "stopped" && record.intent?.kind === "stop") {
        await this.supervisor.stop(this.registry, instanceId);
        continue;
      }
      if (record.desiredState !== "running") continue;
      if (record.intent?.kind === "spawn" || record.intent?.kind === "restart") {
        if (record.processKind === "candidate_release" && this.registry.routing?.candidateBasisPoints !== 0) {
          const safety = this.routing.createRevision(this.registry, 0, "candidate_spawn_replay_safety");
          await this.routing.apply(this.registry, safety, false);
        }
        record = await this.supervisor.replaySpawn(this.registry, record);
        if (record.processKind === "candidate_release") {
          const rebound = this.routing.createRevision(this.registry, 0, "candidate_spawn_replay_bound");
          await this.routing.apply(this.registry, rebound, false);
        }
        continue;
      }
      const status = await this.supervisor.probe(record);
      if (status) await this.supervisor.adopt(this.registry, record);
    }

    await this.routing.reconcile(this.registry, false);
    await this.superviseOnceInternal();
    return this.snapshot();
  }

  private async superviseOnceInternal(): Promise<readonly LivenessResponse[]> {
    this.registry = await this.store.load();
    const responses: LivenessResponse[] = [];
    for (const instanceId of REQUIRED_LIVENESS) {
      const record = this.store.findRecord(this.registry, instanceId);
      if (!record || record.desiredState !== "running" || record.intent) continue;
      const status = await this.supervisor.probe(record);
      if (status) continue;
      switch (record.processKind) {
        case "candidate_release": {
          if (this.registry.routing?.candidateBasisPoints !== 0) {
            const safety = this.routing.createRevision(this.registry, 0, "candidate_liveness_safety");
            await this.routing.apply(this.registry, safety, false);
          } else {
            const traffic = this.store.findRecord(this.registry, TOPOLOGY_INSTANCE_IDS.traffic);
            if (traffic?.observedState === "ready") await this.routing.setTrafficPaused(this.registry, true);
          }
          await this.supervisor.markExited(this.registry, record);
          responses.push({ instanceId, processKind: record.processKind, action: "stable_only_verified" });
          break;
        }
        case "stable_release":
        case "router": {
          const traffic = this.store.findRecord(this.registry, TOPOLOGY_INSTANCE_IDS.traffic);
          if (traffic?.observedState === "ready" && processIsAlive(traffic.pid ?? -1)) {
            await this.routing.setTrafficPaused(this.registry, true);
          }
          await this.routing.closeOpenWindow("interrupted");
          await this.supervisor.markExited(this.registry, record);
          responses.push({ instanceId, processKind: record.processKind, action: "traffic_paused" });
          break;
        }
        case "synthetic_traffic":
          await this.routing.closeOpenWindow("interrupted");
          await this.supervisor.markExited(this.registry, record);
          responses.push({ instanceId, processKind: record.processKind, action: "evidence_interrupted" });
          break;
        case "staging_release":
          break;
      }
    }
    return responses;
  }

  private async assertRequiredLiveness(registry: MutableProcessRegistry): Promise<void> {
    for (const instanceId of REQUIRED_LIVENESS) {
      const record = this.store.requireRecord(registry, instanceId);
      const status = await this.supervisor.probe(record);
      if (!status) throw new Error(`required ${record.processKind} liveness response is unavailable`);
    }
  }

  private startLivenessMonitor(): void {
    if (this.options.livenessIntervalMs <= 0 || this.livenessTimer) return;
    this.livenessTimer = setInterval(() => {
      void this.enqueue(() => this.superviseOnceInternal()).catch(async (error: unknown) => {
        await this.store.appendSupervisorEvent("liveness_supervision_failed", undefined, undefined, {
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
      });
    }, this.options.livenessIntervalMs);
    this.livenessTimer.unref();
  }

  private stopLivenessMonitor(): void {
    if (!this.livenessTimer) return;
    clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
