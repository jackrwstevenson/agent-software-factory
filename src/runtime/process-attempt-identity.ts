import type {
  ProcessAttemptIdentity,
  ProcessAttemptRecord,
  RuntimeDescriptor,
  RuntimeStatus
} from "./runtime-contracts.js";

export type ProcessAttemptIdentityInput = ProcessAttemptIdentity;

export function createProcessAttemptIdentity(input: ProcessAttemptIdentityInput): ProcessAttemptIdentity {
  if (input.factoryRunId.length === 0) throw new TypeError("factoryRunId must not be empty");
  if (input.instanceId.length === 0) throw new TypeError("instanceId must not be empty");
  if (!Number.isInteger(input.processAttempt) || input.processAttempt < 1) throw new TypeError("processAttempt must be a positive integer");
  if (!Number.isInteger(input.pid) || input.pid < 1) throw new TypeError("pid must be a positive integer");
  if (!/^[0-9a-f]{48}$/.test(input.ownershipNonce)) throw new TypeError("ownershipNonce must be 24-byte lowercase hex");
  if (input.processBirthIdentity.length === 0) throw new TypeError("processBirthIdentity must not be empty");
  return Object.freeze({ ...input });
}

export function processAttemptIdentityFrom(
  value: ProcessAttemptRecord | RuntimeDescriptor | RuntimeStatus
): ProcessAttemptIdentity {
  if (value.pid === null || value.processBirthIdentity === null) {
    throw new Error(`incomplete Process Attempt identity for ${value.instanceId}`);
  }
  return createProcessAttemptIdentity({
    factoryRunId: value.factoryRunId,
    instanceId: value.instanceId,
    processKind: value.processKind,
    processAttempt: value.processAttempt,
    releaseId: value.releaseId,
    ownershipNonce: value.ownershipNonce,
    pid: value.pid,
    processBirthIdentity: value.processBirthIdentity
  });
}

export function sameProcessAttemptIdentity(left: ProcessAttemptIdentity, right: ProcessAttemptIdentity): boolean {
  return left.factoryRunId === right.factoryRunId
    && left.instanceId === right.instanceId
    && left.processKind === right.processKind
    && left.processAttempt === right.processAttempt
    && left.releaseId === right.releaseId
    && left.ownershipNonce === right.ownershipNonce
    && left.pid === right.pid
    && left.processBirthIdentity === right.processBirthIdentity;
}

export function assertSameProcessAttemptIdentity(
  expected: ProcessAttemptIdentity,
  observed: ProcessAttemptIdentity,
  description = "Process Attempt identity"
): void {
  if (!sameProcessAttemptIdentity(expected, observed)) throw new Error(`${description} mismatch`);
}
