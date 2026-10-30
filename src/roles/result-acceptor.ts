import type { Digest } from "../protocol/contracts.js";
import type {
  FactoryRole,
  RoleInputManifest,
  RoleResult
} from "./contracts.js";
import { RoleRuntimeError } from "./errors.js";
import { rolePolicy, type RoleResultFor } from "./role-policy.js";

function capturedEventIds(events: Buffer): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of events.toString("utf8").split("\n").filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line) as unknown; } catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    for (const value of [record.id, record.event_id]) {
      if (typeof value === "string") ids.add(`event:${value}`);
    }
    const item = record.item;
    if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
      ids.add(`event:${String((item as { id: string }).id)}`);
    }
  }
  return ids;
}

function collectEvidenceClaims(value: unknown, claims: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectEvidenceClaims(child, claims);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "evidence_claims" && Array.isArray(child)) {
      for (const claim of child) if (typeof claim === "string") claims.add(claim);
    } else {
      collectEvidenceClaims(child, claims);
    }
  }
}

function validateIdentity(input: RoleInputManifest, inputDigest: Digest, result: RoleResult): void {
  if (
    result.factory_run_id !== input.factory_run_id ||
    result.role !== input.role ||
    result.stage_attempt_id !== input.stage_attempt_id ||
    result.invocation_id !== input.invocation_id ||
    result.input_sha256 !== inputDigest
  ) {
    throw new RoleRuntimeError("identity_mismatch", "role result identity does not match its immutable input");
  }
  const expectedCandidate = input.source.candidate?.head_commit_sha ?? null;
  if (result.candidate_head_sha !== expectedCandidate) {
    throw new RoleRuntimeError("candidate_mismatch", "role result is bound to a different Candidate");
  }
}

export class RoleResultAcceptor {
  accept<R extends FactoryRole>(input: Readonly<{
    role: R;
    manifest: RoleInputManifest;
    inputDigest: Digest;
    parsedResult: unknown;
    events: Buffer;
    factIds: readonly string[];
    artifactIds: readonly string[];
  }>): RoleResultFor<R> {
    const policy = rolePolicy(input.role);
    const validation = policy.validate(input.parsedResult);
    if (!validation.ok) {
      throw new RoleRuntimeError("schema_invalid", `Codex final result failed schema validation: ${validation.errors.join("; ")}`);
    }
    const result = validation.value;
    validateIdentity(input.manifest, input.inputDigest, result);
    policy.validateSemantics(input.manifest, result);

    const resolvable = new Set<string>([
      ...capturedEventIds(input.events),
      ...input.factIds,
      ...input.artifactIds
    ]);
    const claims = new Set<string>();
    collectEvidenceClaims(result, claims);
    const unresolved = [...claims].filter((claim) => !resolvable.has(claim)).sort();
    if (unresolved.length > 0) {
      throw new RoleRuntimeError("worker_protocol_error", "role result contains unresolved Evidence Claims", { unresolved });
    }
    return result;
  }
}
