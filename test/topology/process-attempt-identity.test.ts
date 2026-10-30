import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSameProcessAttemptIdentity,
  createProcessAttemptIdentity,
  sameProcessAttemptIdentity
} from "../../src/runtime/process-attempt-identity.js";

const identity = createProcessAttemptIdentity({
  factoryRunId: "fr_identity_test",
  instanceId: "candidate",
  processKind: "candidate_release",
  processAttempt: 2,
  releaseId: "candidate:sha",
  ownershipNonce: "a".repeat(48),
  pid: 41002,
  processBirthIdentity: "41002:Tue Sep 29 10:00:00 2026"
});

test("ProcessAttemptIdentity equality binds every ownership field", () => {
  assert.equal(sameProcessAttemptIdentity(identity, { ...identity }), true);
  for (const changed of [
    { ...identity, factoryRunId: "fr_other" },
    { ...identity, instanceId: "staging" },
    { ...identity, processKind: "staging_release" as const },
    { ...identity, processAttempt: 3 },
    { ...identity, releaseId: "candidate:other" },
    { ...identity, ownershipNonce: "b".repeat(48) },
    { ...identity, pid: 41003 },
    { ...identity, processBirthIdentity: "41003:Tue Sep 29 10:00:01 2026" }
  ]) {
    assert.equal(sameProcessAttemptIdentity(identity, changed), false);
    assert.throws(() => assertSameProcessAttemptIdentity(identity, changed, "test identity"), /test identity mismatch/);
  }
});
