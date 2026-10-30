import assert from "node:assert/strict";
import test from "node:test";

import { validateRoleResult } from "../../src/roles/role-policy.js";

function common(role: "builder" | "verifier" | "reviewer") {
  return {
    schema_version: "1.0",
    contract: "role_result",
    role,
    factory_run_id: "fr_schema_001",
    stage_attempt_id: "fa_schema_001",
    invocation_id: "ri_schema_001",
    input_sha256: "a".repeat(64),
    candidate_head_sha: role === "builder" ? null : "1".repeat(40),
    summary: "bounded",
    evidence_claims: [],
    unresolved_risks: []
  };
}

test("all role result schemas inherit the shared closed envelope and reject hidden authority", () => {
  const results = [
    {
      ...common("builder"),
      decision: "changes_ready",
      role_result: {
        changed_paths: ["product.txt"],
        criteria: [{ criterion: "works", status: "addressed", evidence_claims: [] }],
        commands: [],
        demonstration_summary: "works",
        blocker: null
      }
    },
    {
      ...common("verifier"),
      decision: "passed",
      role_result: {
        checks: [],
        criteria: [{ criterion: "works", status: "passed", evidence_claims: [] }],
        findings: [],
        blocker: null
      }
    },
    {
      ...common("reviewer"),
      decision: "review_complete",
      role_result: {
        findings: [],
        correctness_assessment: "complete",
        security_assessment: "complete",
        risk_factors: [],
        risk_classification: "low",
        blocker: null
      }
    }
  ] as const;

  for (const result of results) {
    assert.equal(validateRoleResult(result.role, result).ok, true);
    const hidden = { ...result, target_lifecycle_state: "succeeded" };
    const validation = validateRoleResult(result.role, hidden);
    assert.equal(validation.ok, false);
    if (!validation.ok) assert.match(validation.errors.join("\n"), /target_lifecycle_state|additional/i);
  }
});
