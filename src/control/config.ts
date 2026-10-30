import type { TerminalOutcome } from "../protocol/contracts.js";
import type { CommitStatusState, GitHubControlConfig } from "./contracts.js";

export const REQUIRED_FACTORY_LABELS = [
  { name: "factory:ready", color: "1D76DB", description: "Human explicitly offers the issue to the factory." },
  { name: "factory:running", color: "FBCA04", description: "A nonterminal Factory Run owns the issue." },
  { name: "factory:needs-approval", color: "D93F0B", description: "The active Factory Run is awaiting human authorization." },
  { name: "factory:paused", color: "6A737D", description: "The active Factory Run is Paused for Operator." },
  { name: "factory:succeeded", color: "0E8A16", description: "The Factory Run Succeeded." },
  { name: "factory:rejected", color: "5319E7", description: "Authorization rejected the Candidate Release." },
  { name: "factory:failed", color: "B60205", description: "The Factory Run Failed." },
  { name: "factory:rolled-back", color: "E99695", description: "Candidate exposure ended in a successful safety rollback." },
  { name: "factory:aborted", color: "6A737D", description: "A human stopped the Factory Run." }
] as const;

export type FactoryLifecycleLabel = typeof REQUIRED_FACTORY_LABELS[number]["name"];

export const FACTORY_LIFECYCLE_LABELS: ReadonlySet<FactoryLifecycleLabel> = new Set(
  REQUIRED_FACTORY_LABELS.map((label) => label.name)
);

export const ACTIVE_OR_TERMINAL_FACTORY_LABELS: ReadonlySet<FactoryLifecycleLabel> = new Set(
  [...FACTORY_LIFECYCLE_LABELS].filter((label) => label !== "factory:ready")
);

export function isFactoryLifecycleLabel(label: string): label is FactoryLifecycleLabel {
  return (FACTORY_LIFECYCLE_LABELS as ReadonlySet<string>).has(label);
}

export function isActiveOrTerminalFactoryLabel(label: string): label is FactoryLifecycleLabel {
  return (ACTIVE_OR_TERMINAL_FACTORY_LABELS as ReadonlySet<string>).has(label);
}

export const TERMINAL_FACTORY_LABEL_BY_OUTCOME = {
  succeeded: "factory:succeeded",
  rejected: "factory:rejected",
  failed: "factory:failed",
  rolled_back: "factory:rolled-back",
  aborted: "factory:aborted"
} as const satisfies Readonly<Record<TerminalOutcome, FactoryLifecycleLabel>>;

export type TerminalFactoryLabel = typeof TERMINAL_FACTORY_LABEL_BY_OUTCOME[TerminalOutcome];

export const TERMINAL_ROLLOUT_STATUS_BY_OUTCOME = {
  succeeded: { state: "success", description: "Factory Run Succeeded" },
  rejected: null,
  failed: { state: "error", description: "Factory Run Failed" },
  rolled_back: { state: "failure", description: "Factory Run Rolled Back" },
  aborted: { state: "error", description: "Factory Run Aborted" }
} as const satisfies Readonly<Record<
  TerminalOutcome,
  Readonly<{ state: CommitStatusState; description: string }> | null
>>;

export const DEFAULT_GITHUB_CONTROL_CONFIG: GitHubControlConfig = {
  host: "github.org.com",
  repository: "engineering/agentic-software-factory",
  defaultBranch: "main",
  expectedCliVersion: "2.96.0",
  expectedEnterpriseVersion: "3.19.10",
  restApiVersion: "2022-11-28",
  factoryLogin: "GH_ENTERPRISE_USERNAME"
};
