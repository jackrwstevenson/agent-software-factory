export interface CodexProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly wireApi: "responses" | "chat";
  readonly environmentKey: string;
  readonly requiresOpenAIAuth: boolean;
}

function toml(value: string): string { return JSON.stringify(value); }

export function providerConfigArgs(provider: CodexProviderConfig | null): readonly string[] {
  if (provider === null) return [];
  const prefix = `model_providers.${provider.id}`;
  return [
    "-c", `model_provider=${toml(provider.id)}`,
    "-c", `${prefix}.name=${toml(provider.name)}`,
    "-c", `${prefix}.base_url=${toml(provider.baseUrl)}`,
    "-c", `${prefix}.wire_api=${toml(provider.wireApi)}`,
    "-c", `${prefix}.env_key=${toml(provider.environmentKey)}`,
    "-c", `${prefix}.requires_openai_auth=${provider.requiresOpenAIAuth}`
  ];
}

export function providerCredentialEnvironment(
  provider: CodexProviderConfig | null,
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  if (provider === null) return {};
  const value = environment[provider.environmentKey];
  if (value === undefined || value === "") throw new Error(`Codex provider credential ${provider.environmentKey} is unavailable`);
  return { [provider.environmentKey]: value };
}
