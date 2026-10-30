import { createHash } from "node:crypto";
import { ALGORITHM_ID, createRouter, createSyntheticUsers, SYNTHETIC_WORKLOAD_ID } from "./routing.js";
import type { ProcessKind } from "./runtime-contracts.js";

export type RoutingReason = string;

export interface RuntimeTarget {
  readonly instanceId: string;
  readonly releaseId: string;
  readonly processKind: "stable_release" | "candidate_release";
  readonly processAttempt: number;
  readonly ownershipNonce: string;
  readonly pid: number;
  readonly processBirthIdentity: string;
  readonly endpoint: string;
}

export interface PriorRoutingRevision {
  readonly revision: number;
  readonly fullFingerprint: string;
}

export interface WorkloadManifest {
  readonly version: typeof SYNTHETIC_WORKLOAD_ID;
  readonly userCount: 10_000;
  readonly usersDigest: string;
}

export interface RoutingRevision {
  readonly schemaVersion: "1.0";
  readonly contract: "runtime_routing_revision";
  readonly revision: number;
  readonly reason: RoutingReason;
  readonly priorRevision: PriorRoutingRevision | null;
  readonly algorithmId: typeof ALGORITHM_ID;
  readonly factoryRunId: string;
  readonly rolloutSeed: string;
  readonly stable: RuntimeTarget;
  readonly candidate: RuntimeTarget;
  readonly candidateBasisPoints: number;
  readonly workload: WorkloadManifest;
  readonly configFingerprint: string;
  readonly fullFingerprint: string;
}

export interface RoutingRevisionInput {
  readonly revision: number;
  readonly reason: RoutingReason;
  readonly priorRevision: PriorRoutingRevision | null;
  readonly factoryRunId: string;
  readonly rolloutSeed: string;
  readonly stable: RuntimeTarget;
  readonly candidate: RuntimeTarget;
  readonly candidateBasisPoints: number;
  readonly workload: WorkloadManifest;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertDigest(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`);
}

function canonicalRevision(value: Omit<RoutingRevision, "fullFingerprint">): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    contract: value.contract,
    revision: value.revision,
    reason: value.reason,
    priorRevision: value.priorRevision,
    algorithmId: value.algorithmId,
    factoryRunId: value.factoryRunId,
    rolloutSeed: value.rolloutSeed,
    stable: value.stable,
    candidate: value.candidate,
    candidateBasisPoints: value.candidateBasisPoints,
    workload: value.workload,
    configFingerprint: value.configFingerprint
  });
}

export function workloadManifestV1(): WorkloadManifest {
  const users = createSyntheticUsers();
  return Object.freeze({
    version: SYNTHETIC_WORKLOAD_ID,
    userCount: 10_000,
    usersDigest: sha256(users.join("\n"))
  });
}

function assertTarget(target: RuntimeTarget, expectedKind: ProcessKind): void {
  if (target.processKind !== expectedKind) throw new TypeError(`routing target must be ${expectedKind}`);
  if (!Number.isInteger(target.processAttempt) || target.processAttempt < 1) throw new TypeError("target processAttempt must be a positive integer");
  if (!Number.isInteger(target.pid) || target.pid < 1) throw new TypeError("target pid must be a positive integer");
  if (!/^[0-9a-f]{48}$/.test(target.ownershipNonce)) throw new TypeError("target ownershipNonce must be 24-byte lowercase hex");
  if (target.processBirthIdentity.length === 0) throw new TypeError("target processBirthIdentity must not be empty");
  const url = new URL(target.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new TypeError("routing targets must use loopback HTTP endpoints");
}

export function createRoutingRevision(input: RoutingRevisionInput): RoutingRevision {
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new TypeError("routing revision must be a positive integer");
  if (input.reason.length === 0) throw new TypeError("routing reason must not be empty");
  if (input.priorRevision) {
    if (!Number.isInteger(input.priorRevision.revision) || input.priorRevision.revision < 1) throw new TypeError("prior routing revision must be positive");
    assertDigest(input.priorRevision.fullFingerprint, "prior routing fullFingerprint");
  }
  if (input.workload.version !== SYNTHETIC_WORKLOAD_ID || input.workload.userCount !== 10_000) {
    throw new TypeError("routing workload manifest must be synthetic-users-v1 with 10,000 users");
  }
  assertDigest(input.workload.usersDigest, "workload usersDigest");
  assertTarget(input.stable, "stable_release");
  assertTarget(input.candidate, "candidate_release");
  const router = createRouter({
    algorithmId: ALGORITHM_ID,
    factoryRunId: input.factoryRunId,
    rolloutSeed: input.rolloutSeed,
    stableReleaseId: input.stable.releaseId,
    candidateReleaseId: input.candidate.releaseId,
    candidateBasisPoints: input.candidateBasisPoints
  });
  const base = Object.freeze({
    schemaVersion: "1.0" as const,
    contract: "runtime_routing_revision" as const,
    revision: input.revision,
    reason: input.reason,
    priorRevision: input.priorRevision ? Object.freeze({ ...input.priorRevision }) : null,
    algorithmId: ALGORITHM_ID,
    factoryRunId: input.factoryRunId,
    rolloutSeed: input.rolloutSeed,
    stable: Object.freeze({ ...input.stable }),
    candidate: Object.freeze({ ...input.candidate }),
    candidateBasisPoints: input.candidateBasisPoints,
    workload: Object.freeze({ ...input.workload }),
    configFingerprint: router.configFingerprint
  });
  return Object.freeze({ ...base, fullFingerprint: sha256(canonicalRevision(base)) });
}

export function assertRoutingRevisionSelfConsistent(revision: RoutingRevision): void {
  const recomputed = createRoutingRevision({
    revision: revision.revision,
    reason: revision.reason,
    priorRevision: revision.priorRevision,
    factoryRunId: revision.factoryRunId,
    rolloutSeed: revision.rolloutSeed,
    stable: revision.stable,
    candidate: revision.candidate,
    candidateBasisPoints: revision.candidateBasisPoints,
    workload: revision.workload
  });
  if (recomputed.configFingerprint !== revision.configFingerprint || recomputed.fullFingerprint !== revision.fullFingerprint) {
    throw new Error("routing revision self-fingerprint mismatch");
  }
}

export function assertRoutingRevisionTransition(prior: RoutingRevision | null, next: RoutingRevision): void {
  assertRoutingRevisionSelfConsistent(next);
  if (prior === null) {
    if (next.revision !== 1) throw new Error(`skipped routing revision: expected 1, got ${next.revision}`);
    if (next.priorRevision !== null) throw new Error("prior routing revision mismatch for initial revision");
    return;
  }
  assertRoutingRevisionSelfConsistent(prior);
  if (next.revision < prior.revision) throw new Error(`lower routing revision ${next.revision} after ${prior.revision}`);
  if (next.revision === prior.revision) {
    if (next.fullFingerprint !== prior.fullFingerprint) throw new Error(`conflicting routing revision ${next.revision}`);
    return;
  }
  if (next.revision > prior.revision + 1) throw new Error(`skipped routing revision: expected ${prior.revision + 1}, got ${next.revision}`);
  if (
    next.priorRevision?.revision !== prior.revision
    || next.priorRevision.fullFingerprint !== prior.fullFingerprint
  ) {
    throw new Error(`prior routing revision mismatch for revision ${next.revision}`);
  }
}

export async function applyRoutingRevision(
  prior: RoutingRevision | null,
  revision: RoutingRevision,
  endpoint: {
    readonly apply: (revision: RoutingRevision) => Promise<void>;
    readonly readBack: () => Promise<RoutingRevision>;
  }
): Promise<RoutingRevision> {
  assertRoutingRevisionTransition(prior, revision);
  await endpoint.apply(revision);
  const observed = await endpoint.readBack();
  assertRoutingRevisionSelfConsistent(observed);
  if (observed.fullFingerprint !== revision.fullFingerprint) {
    throw new Error(`routing read-back fingerprint mismatch: expected ${revision.fullFingerprint}, got ${observed.fullFingerprint}`);
  }
  return observed;
}
