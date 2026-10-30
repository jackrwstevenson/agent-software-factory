import { createHash } from "node:crypto";

export const ALGORITHM_ID = "sha256-sticky-basis-points-v1" as const;
export const BUCKET_COUNT = 10_000;
export const SYNTHETIC_WORKLOAD_ID = "synthetic-users-v1" as const;

export interface RoutingConfig {
  readonly algorithmId: typeof ALGORITHM_ID;
  readonly factoryRunId: string;
  readonly rolloutSeed: string;
  readonly stableReleaseId: string;
  readonly candidateReleaseId: string;
  readonly candidateBasisPoints: number;
}

export interface RoutingDecision extends RoutingConfig {
  readonly configFingerprint: string;
  readonly userId: string;
  readonly bucket: number;
  readonly target: "stable" | "candidate";
  readonly releaseId: string;
}

export interface DeterministicRouter {
  readonly algorithmId: typeof ALGORITHM_ID;
  readonly config: RoutingConfig;
  readonly configFingerprint: string;
  decide(userId: string): RoutingDecision;
}

const CONFIG_KEYS = new Set<keyof RoutingConfig>([
  "algorithmId",
  "factoryRunId",
  "rolloutSeed",
  "stableReleaseId",
  "candidateReleaseId",
  "candidateBasisPoints"
]);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string", `${name} must be a string`);
  invariant(value.length > 0, `${name} must not be empty`);
  invariant(value.length <= 256, `${name} must be at most 256 characters`);
  invariant(!value.includes("\0"), `${name} must not contain a NUL byte`);
}

function normalizeConfig(input: RoutingConfig): RoutingConfig {
  invariant(input !== null && typeof input === "object" && !Array.isArray(input), "routing config must be an object");
  const record = input as unknown as Record<string, unknown>;
  const keys = Object.keys(record);
  const unknown = keys.filter((key) => !CONFIG_KEYS.has(key as keyof RoutingConfig));
  const missing = [...CONFIG_KEYS].filter((key) => !Object.hasOwn(record, key));
  invariant(unknown.length === 0, `unknown routing config keys: ${unknown.join(", ")}`);
  invariant(missing.length === 0, `missing routing config keys: ${missing.join(", ")}`);
  invariant(record.algorithmId === ALGORITHM_ID, `algorithmId must be ${ALGORITHM_ID}`);
  assertIdentifier(record.factoryRunId, "factoryRunId");
  assertIdentifier(record.rolloutSeed, "rolloutSeed");
  assertIdentifier(record.stableReleaseId, "stableReleaseId");
  assertIdentifier(record.candidateReleaseId, "candidateReleaseId");
  invariant(record.stableReleaseId !== record.candidateReleaseId, "stableReleaseId and candidateReleaseId must be different");
  invariant(Number.isInteger(record.candidateBasisPoints), "candidateBasisPoints must be an integer");
  invariant(
    (record.candidateBasisPoints as number) >= 0 && (record.candidateBasisPoints as number) <= BUCKET_COUNT,
    `candidateBasisPoints must be between 0 and ${BUCKET_COUNT}`
  );
  return Object.freeze({
    algorithmId: ALGORITHM_ID,
    factoryRunId: record.factoryRunId,
    rolloutSeed: record.rolloutSeed,
    stableReleaseId: record.stableReleaseId,
    candidateReleaseId: record.candidateReleaseId,
    candidateBasisPoints: record.candidateBasisPoints as number
  });
}

function hash64(text: string): bigint {
  return createHash("sha256").update(text, "utf8").digest().readBigUInt64BE(0);
}

export function bucketForUser(config: RoutingConfig, userId: string): number {
  assertIdentifier(userId, "userId");
  const hashInput = `${config.algorithmId}\0${config.factoryRunId}\0${config.rolloutSeed}\0${userId}`;
  return Number(hash64(hashInput) % BigInt(BUCKET_COUNT));
}

export function routingConfigFingerprint(config: RoutingConfig): string {
  const canonical = [
    config.algorithmId,
    config.factoryRunId,
    config.rolloutSeed,
    config.stableReleaseId,
    config.candidateReleaseId,
    String(config.candidateBasisPoints)
  ].join("\0");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createRouter(input: RoutingConfig): DeterministicRouter {
  const config = normalizeConfig(input);
  const configFingerprint = routingConfigFingerprint(config);
  return Object.freeze({
    algorithmId: ALGORITHM_ID,
    config,
    configFingerprint,
    decide(userId: string): RoutingDecision {
      const bucket = bucketForUser(config, userId);
      const target = bucket < config.candidateBasisPoints ? "candidate" : "stable";
      return Object.freeze({
        algorithmId: config.algorithmId,
        configFingerprint,
        factoryRunId: config.factoryRunId,
        rolloutSeed: config.rolloutSeed,
        userId,
        bucket,
        candidateBasisPoints: config.candidateBasisPoints,
        target,
        releaseId: target === "candidate" ? config.candidateReleaseId : config.stableReleaseId,
        stableReleaseId: config.stableReleaseId,
        candidateReleaseId: config.candidateReleaseId
      });
    }
  });
}

export function createSyntheticUsers(count = BUCKET_COUNT): readonly string[] {
  invariant(Number.isInteger(count) && count > 0, "synthetic user count must be a positive integer");
  return Object.freeze(Array.from({ length: count }, (_, index) => `synthetic-user-${String(index).padStart(5, "0")}`));
}
