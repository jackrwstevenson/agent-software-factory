import type { ProcessKind } from "./runtime-contracts.js";

interface ChildSpecBase {
  readonly factoryRunId: string;
  readonly instanceId: string;
  readonly processAttempt: number;
  readonly ownershipNonce: string;
  readonly runtimeDescriptorPath: string;
  readonly ignoreSigterm: boolean;
}

export interface ReleaseChildSpec extends ChildSpecBase {
  readonly processKind: "stable_release" | "staging_release" | "candidate_release";
  readonly releaseId: string;
}

export interface RouterChildSpec extends ChildSpecBase {
  readonly processKind: "router";
  readonly releaseId: null;
  readonly routingCurrentPath: string;
  readonly runtimeEventJournalPath: string;
}

export interface SyntheticTrafficChildSpec extends ChildSpecBase {
  readonly processKind: "synthetic_traffic";
  readonly releaseId: null;
  readonly routerEndpoint: string;
}

export type ProcessChildSpec = ReleaseChildSpec | RouterChildSpec | SyntheticTrafficChildSpec;

const PROCESS_KINDS = new Set<ProcessKind>([
  "stable_release",
  "staging_release",
  "candidate_release",
  "router",
  "synthetic_traffic"
]);

export function parseProcessChildSpec(value: unknown): ProcessChildSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("child spec must be an object");
  const input = value as Record<string, unknown>;
  if (!PROCESS_KINDS.has(input.processKind as ProcessKind)) throw new TypeError("child spec has an invalid processKind");
  for (const name of ["factoryRunId", "instanceId", "ownershipNonce", "runtimeDescriptorPath"]) {
    if (typeof input[name] !== "string" || input[name].length === 0) throw new TypeError(`child spec ${name} must be a nonempty string`);
  }
  if (!Number.isInteger(input.processAttempt) || (input.processAttempt as number) < 1) throw new TypeError("child spec processAttempt must be positive");
  if (typeof input.ignoreSigterm !== "boolean") throw new TypeError("child spec ignoreSigterm must be boolean");
  const processKind = input.processKind as ProcessKind;
  const commonKeys = ["factoryRunId", "instanceId", "processAttempt", "processKind", "releaseId", "ownershipNonce", "runtimeDescriptorPath", "ignoreSigterm"];
  const kindKeys = processKind === "router"
    ? ["routingCurrentPath", "runtimeEventJournalPath"]
    : processKind === "synthetic_traffic" ? ["routerEndpoint"] : [];
  const allowed = new Set([...commonKeys, ...kindKeys]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`unknown child spec keys: ${unknown.join(", ")}`);
  const common = {
    factoryRunId: input.factoryRunId as string,
    instanceId: input.instanceId as string,
    processAttempt: input.processAttempt as number,
    ownershipNonce: input.ownershipNonce as string,
    runtimeDescriptorPath: input.runtimeDescriptorPath as string,
    ignoreSigterm: input.ignoreSigterm as boolean
  };
  if (processKind === "router") {
    if (input.releaseId !== null || typeof input.routingCurrentPath !== "string" || typeof input.runtimeEventJournalPath !== "string") {
      throw new TypeError("router child spec is incomplete");
    }
    return Object.freeze({ ...common, processKind, releaseId: null, routingCurrentPath: input.routingCurrentPath, runtimeEventJournalPath: input.runtimeEventJournalPath });
  }
  if (processKind === "synthetic_traffic") {
    if (input.releaseId !== null || typeof input.routerEndpoint !== "string") throw new TypeError("Synthetic Traffic child spec is incomplete");
    return Object.freeze({ ...common, processKind, releaseId: null, routerEndpoint: input.routerEndpoint });
  }
  if (typeof input.releaseId !== "string" || input.releaseId.length === 0) throw new TypeError("Release child spec requires releaseId");
  return Object.freeze({ ...common, processKind, releaseId: input.releaseId });
}
