import assert from "node:assert/strict";
import test from "node:test";
import { parseProcessChildSpec } from "../../src/runtime/child-spec.js";

const common = {
  factoryRunId: "fr_child_spec",
  instanceId: "stable",
  processAttempt: 1,
  ownershipNonce: "a".repeat(48),
  runtimeDescriptorPath: "/tmp/runtime.json",
  ignoreSigterm: false
};

test("ProcessKind-discriminated child specs reject impossible fields", () => {
  assert.equal(parseProcessChildSpec({ ...common, processKind: "stable_release", releaseId: "stable:sha" }).processKind, "stable_release");
  assert.throws(
    () => parseProcessChildSpec({ ...common, processKind: "stable_release", releaseId: "stable:sha", routingCurrentPath: "/tmp/route.json" }),
    /unknown child spec keys/
  );
  assert.throws(
    () => parseProcessChildSpec({ ...common, processKind: "router", releaseId: null, routingCurrentPath: "/tmp/route.json" }),
    /router child spec is incomplete/
  );
  assert.throws(
    () => parseProcessChildSpec({ ...common, processKind: "synthetic_traffic", releaseId: null, routerEndpoint: "http://127.0.0.1:41000", runtimeEventJournalPath: "/tmp/events" }),
    /unknown child spec keys/
  );
});
