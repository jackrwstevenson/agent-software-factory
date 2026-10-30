import assert from "node:assert/strict";
import test from "node:test";

import { FACTORY_ROLE_POLICIES } from "../../src/roles/role-policy.js";

const expected = {
  builder: { sandbox: "workspace-write", lifecycleState: "building", successDecision: "changes_ready" },
  verifier: { sandbox: "read-only", lifecycleState: "verifying", successDecision: "passed" },
  reviewer: { sandbox: "read-only", lifecycleState: "reviewing", successDecision: "review_complete" }
} as const;

test("the typed FactoryRole policy map is the single source of role schema, sandbox, decision, validator, and adapter policy", () => {
  assert.deepEqual(Object.keys(FACTORY_ROLE_POLICIES).sort(), ["builder", "reviewer", "verifier"]);
  for (const role of Object.keys(expected) as Array<keyof typeof expected>) {
    const policy = FACTORY_ROLE_POLICIES[role];
    assert.equal(policy.role, role);
    assert.equal(policy.sandbox, expected[role].sandbox);
    assert.equal(policy.lifecycleState, expected[role].lifecycleState);
    assert.equal(policy.successDecision, expected[role].successDecision);
    assert.equal(typeof policy.validate, "function");
    assert.equal(typeof policy.validateSemantics, "function");
    assert.equal(typeof policy.adaptLegacyResult, "function");
    assert.equal(typeof policy.schema, "object");
  }
});
