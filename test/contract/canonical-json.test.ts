import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalSha256 } from "../../src/protocol/canonical-json.js";

test("canonical JSON has a stable ordering and digest", () => {
  const value = {
    z: [3, { beta: true, alpha: null }],
    a: "factory",
    nested: { y: 2, x: 1 }
  };

  assert.equal(
    canonicalJson(value),
    '{"a":"factory","nested":{"x":1,"y":2},"z":[3,{"alpha":null,"beta":true}]}'
  );
  assert.equal(
    canonicalSha256(value),
    "955f472867cdc5f51635531df3bf43b8fd980575a8ec23b26358cc15c6c8a6e0"
  );
});

test("canonical JSON rejects values that cannot be persisted deterministically", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /finite/);
});
