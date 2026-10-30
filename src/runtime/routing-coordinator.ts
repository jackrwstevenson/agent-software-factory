import { setTimeout as delay } from "node:timers/promises";
import {
  FileRuntimeEventJournal,
  type RuntimeReplayState
} from "./request-journal.js";
import type { ProcessAttemptIdentity } from "./runtime-contracts.js";
import { processAttemptIdentityFrom, sameProcessAttemptIdentity } from "./process-attempt-identity.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import {
  assertRoutingRevisionTransition,
  createRoutingRevision,
  workloadManifestV1,
  type RoutingRevision,
  type RuntimeTarget
} from "./routing-revision.js";
import {
  TopologyRegistryStore,
  type MutableProcessRegistry
} from "./topology-registry-store.js";

export interface RoutingCoordinatorOptions {
  readonly startupDeadlineMs: number;
  readonly probeIntervalMs: number;
  readonly rolloutSeed: string;
}

function now(): string {
  return new Date().toISOString();
}

export class RoutingCoordinator {
  constructor(
    private readonly store: TopologyRegistryStore,
    private readonly supervisor: ProcessSupervisor,
    private readonly options: RoutingCoordinatorOptions
  ) {}

  createRevision(registry: MutableProcessRegistry, candidateBasisPoints: number, reason: string): RoutingRevision {
    if (registry.desiredRouting && registry.routing?.fullFingerprint !== registry.desiredRouting.fullFingerprint) {
      throw new Error("cannot create a routing revision while another desiredRouting intent is incomplete");
    }
    const prior = registry.routing;
    return createRoutingRevision({
      revision: (prior?.revision ?? 0) + 1,
      reason,
      priorRevision: prior ? { revision: prior.revision, fullFingerprint: prior.fullFingerprint } : null,
      factoryRunId: registry.factoryRunId,
      rolloutSeed: this.options.rolloutSeed,
      stable: this.targetFor(this.store.requireRecord(registry, "stable"), "stable_release"),
      candidate: this.targetFor(this.store.requireRecord(registry, "candidate"), "candidate_release"),
      candidateBasisPoints,
      workload: workloadManifestV1()
    });
  }

  async recordDesired(registry: MutableProcessRegistry, revision: RoutingRevision): Promise<void> {
    assertRoutingRevisionTransition(registry.routing, revision);
    if (registry.desiredRouting && registry.desiredRouting.fullFingerprint !== registry.routing?.fullFingerprint) {
      if (registry.desiredRouting.fullFingerprint !== revision.fullFingerprint) throw new Error("conflicting desiredRouting intent");
    }
    registry.desiredRouting = revision;
    await this.store.save(registry);
    const journal = await FileRuntimeEventJournal.open(this.store.runtimeEventJournalPath);
    const replay = journal.replayState();
    if (replay.desiredRouting?.fullFingerprint !== revision.fullFingerprint) {
      if (replay.desiredRouting && replay.appliedRouting?.fullFingerprint !== replay.desiredRouting.fullFingerprint) {
        throw new Error("conflicting pending routing journal intent");
      }
      journal.append({ type: "routing_change_pending", factoryRunId: registry.factoryRunId, at: now(), revision });
    }
    await this.store.persistRoutingRevision(revision);
  }

  async apply(
    registry: MutableProcessRegistry,
    revision: RoutingRevision,
    resumeTraffic = true
  ): Promise<RoutingRevision> {
    const trafficReady = this.store.findRecord(registry, "synthetic-traffic")?.observedState === "ready";
    if (trafficReady) await this.setTrafficPaused(registry, true);
    await this.closeOpenWindow("routing_change");
    await this.recordDesired(registry, revision);
    await this.verifyRoutingReadBack(registry, revision);
    registry.routing = revision;
    registry.desiredRouting = revision;
    await this.store.save(registry);
    const journal = await FileRuntimeEventJournal.open(this.store.runtimeEventJournalPath);
    const replay = journal.replayState();
    if (replay.appliedRouting?.fullFingerprint !== revision.fullFingerprint) {
      journal.append({ type: "routing_change_applied", factoryRunId: registry.factoryRunId, at: now(), revision });
    }
    await this.openWindow(revision);
    if (trafficReady && resumeTraffic) await this.setTrafficPaused(registry, false);
    return revision;
  }

  async reconcile(registry: MutableProcessRegistry, resumeTraffic = false): Promise<void> {
    if (!registry.desiredRouting) return;
    assertRoutingRevisionTransition(registry.routing, registry.desiredRouting);
    if (registry.routing?.fullFingerprint === registry.desiredRouting.fullFingerprint) {
      await this.verifyRoutingReadBack(registry, registry.routing);
      return;
    }
    await this.apply(registry, registry.desiredRouting, resumeTraffic);
  }

  async setTrafficPaused(registry: MutableProcessRegistry, paused: boolean): Promise<void> {
    const traffic = this.store.requireRecord(registry, "synthetic-traffic");
    if (!traffic.endpoint || traffic.observedState !== "ready") throw new Error("Synthetic Traffic is not ready for routing coordination");
    const response = await fetch(`${traffic.endpoint}/__factory/${paused ? "pause" : "resume"}`, {
      method: "POST",
      signal: AbortSignal.timeout(1_000)
    });
    if (!response.ok) throw new Error(`Synthetic Traffic ${paused ? "pause" : "resume"} returned HTTP ${response.status}`);
    const deadline = Date.now() + this.options.startupDeadlineMs;
    while (Date.now() < deadline) {
      const status = await this.supervisor.readStatus(registry, "synthetic-traffic");
      if (status.details.paused === paused && (!paused || status.details.inFlight === 0)) {
        await this.store.appendSupervisorEvent(paused ? "traffic_paused" : "traffic_resumed", traffic.instanceId, traffic.processAttempt);
        return;
      }
      await delay(this.options.probeIntervalMs);
    }
    throw new Error(`Synthetic Traffic ${paused ? "pause" : "resume"} read-back mismatch`);
  }

  async closeOpenWindow(reason: "routing_change" | "shutdown" | "interrupted"): Promise<void> {
    const journal = await FileRuntimeEventJournal.open(this.store.runtimeEventJournalPath);
    const replay = journal.replayState();
    const open = replay.windows.find((window) => window.closedAt === null);
    if (!open) return;
    journal.append({
      type: "traffic_window_closed",
      factoryRunId: open.revision.factoryRunId,
      at: now(),
      windowId: open.windowId,
      revision: open.revision,
      reason
    });
  }

  private async openWindow(revision: RoutingRevision): Promise<void> {
    const journal = await FileRuntimeEventJournal.open(this.store.runtimeEventJournalPath);
    const replay = journal.replayState();
    const windowId = `routing-window-${revision.revision}`;
    if (replay.windows.some((window) => window.windowId === windowId)) return;
    journal.append({
      type: "traffic_window_opened",
      factoryRunId: revision.factoryRunId,
      at: now(),
      windowId,
      revision
    });
  }

  private async verifyRoutingReadBack(registry: MutableProcessRegistry, expected: RoutingRevision): Promise<void> {
    this.assertCurrentTargetIdentity(registry, expected);
    const router = this.store.requireRecord(registry, "router");
    if (!router.endpoint || router.observedState !== "ready") throw new Error("Router is not ready for routing read-back");
    const deadline = Date.now() + this.options.startupDeadlineMs;
    while (Date.now() < deadline) {
      try {
        const status = await this.supervisor.readStatus(registry, "router");
        if (
          status.details.appliedRoutingFullFingerprint === expected.fullFingerprint
          && status.details.appliedRoutingRevision === expected.revision
        ) return;
      } catch {
        // Retry until the bounded read-back deadline.
      }
      await delay(this.options.probeIntervalMs);
    }
    throw new Error(`routing read-back fingerprint mismatch for revision ${expected.revision}`);
  }

  private assertCurrentTargetIdentity(registry: MutableProcessRegistry, revision: RoutingRevision): void {
    const stable = processAttemptIdentityFrom(this.store.requireRecord(registry, "stable"));
    const candidate = processAttemptIdentityFrom(this.store.requireRecord(registry, "candidate"));
    if (!sameProcessAttemptIdentity(stable, this.identityFromTarget(registry.factoryRunId, revision.stable))) {
      throw new Error("Stable routing target ownership identity is stale");
    }
    if (!sameProcessAttemptIdentity(candidate, this.identityFromTarget(registry.factoryRunId, revision.candidate))) {
      throw new Error("Candidate routing target ownership identity is stale");
    }
  }

  private targetFor(
    record: ReturnType<TopologyRegistryStore["requireRecord"]>,
    expectedKind: "stable_release" | "candidate_release"
  ): RuntimeTarget {
    if (record.processKind !== expectedKind || !record.releaseId || !record.endpoint || !record.pid || !record.processBirthIdentity) {
      throw new Error(`${record.instanceId} is not a routable ${expectedKind} Process Attempt`);
    }
    return {
      instanceId: record.instanceId,
      releaseId: record.releaseId,
      processKind: expectedKind,
      processAttempt: record.processAttempt,
      ownershipNonce: record.ownershipNonce,
      pid: record.pid,
      processBirthIdentity: record.processBirthIdentity,
      endpoint: record.endpoint
    };
  }

  private identityFromTarget(factoryRunId: string, target: RuntimeTarget): ProcessAttemptIdentity {
    return {
      factoryRunId,
      instanceId: target.instanceId,
      processKind: target.processKind,
      processAttempt: target.processAttempt,
      releaseId: target.releaseId,
      ownershipNonce: target.ownershipNonce,
      pid: target.pid,
      processBirthIdentity: target.processBirthIdentity
    };
  }
}

export type { RuntimeReplayState };
