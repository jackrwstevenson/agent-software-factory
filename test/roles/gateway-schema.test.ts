import assert from "node:assert/strict";
import test from "node:test";
import builderSchema from "../../schemas/v1/role-builder-result.schema.json" with { type: "json" };
import sentinelSchema from "../../schemas/v1/role-runtime-sentinel.schema.json" with { type: "json" };
import { providerCompatibleRoleSchema, providerCompatibleSchema } from "../../src/roles/gateway-schema.js";

function assertStrict(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertStrict);
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.const !== undefined) assert.ok(record.type !== undefined);
  if (record.type === "object" && record.properties && typeof record.properties === "object") {
    assert.deepEqual(new Set(record.required as string[]), new Set(Object.keys(record.properties as object)));
    assert.equal(record.additionalProperties, false);
  }
  Object.values(record).forEach(assertStrict);
}

test("corporate gateway schemas add strict types and required object fields", () => {
  assertStrict(providerCompatibleSchema(sentinelSchema));
  const role = providerCompatibleRoleSchema(builderSchema) as Record<string, unknown>;
  assert.equal(role.allOf, undefined);
  assertStrict(role);
});
