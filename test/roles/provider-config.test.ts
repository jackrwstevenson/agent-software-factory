import assert from "node:assert/strict";
import test from "node:test";

import { providerConfigArgs, providerCredentialEnvironment } from "../../src/roles/provider-config.js";

const provider = {
  id: "ica",
  name: "ICA",
  baseUrl: "https://gateway.example.test/v1",
  wireApi: "responses" as const,
  environmentKey: "ICA_API_KEY",
  requiresOpenAIAuth: false
};

test("corporate provider configuration is explicit and does not require OpenAI login", () => {
  const args = providerConfigArgs(provider).join("\n");
  assert.match(args, /model_provider="ica"/);
  assert.match(args, /model_providers\.ica\.requires_openai_auth=false/);
  assert.doesNotMatch(args, /secret-value/);
  assert.deepEqual(providerCredentialEnvironment(provider, { ICA_API_KEY: "secret-value" }), { ICA_API_KEY: "secret-value" });
});

test("provider credential is required for the Codex parent only", () => {
  assert.throws(() => providerCredentialEnvironment(provider, {}), /ICA_API_KEY is unavailable/);
  assert.deepEqual(providerConfigArgs(null), []);
  assert.deepEqual(providerCredentialEnvironment(null, {}), {});
});
