import { rm } from "node:fs/promises";

import { readJsonFile, writeDurableJsonFile } from "../journal/durable-json-file.js";
import { validateProtocol } from "../protocol/schemas.js";
import type {
  GitHubPreflightEvidence,
  SourceCapabilityRecord
} from "./contracts.js";

export function sourceCapabilityRecord(input: {
  readonly github: GitHubPreflightEvidence;
  readonly observedAt: string;
  readonly selectedBranchMode: "linked" | "pure_git";
  readonly evidence: string;
}): SourceCapabilityRecord {
  return {
    schemaVersion: "1.0",
    contract: "source_capability",
    host: "github.org.com",
    repository: "engineering/agentic-software-factory",
    gitHubCliVersion: input.github.cliVersion,
    linkedBranches: input.selectedBranchMode === "linked" ? "supported" : "unsupported",
    selectedBranchMode: input.selectedBranchMode,
    evidence: input.evidence,
    observedAt: input.observedAt
  };
}

export class FileSourceCapabilityStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async save(value: SourceCapabilityRecord): Promise<SourceCapabilityRecord> {
    const validation = validateProtocol<SourceCapabilityRecord>("source-capability", value);
    if (!validation.ok) throw new Error(`source capability contract violation: ${validation.errors.join("; ")}`);
    await writeDurableJsonFile(this.#path, value);
    return value;
  }

  async record(
    github: GitHubPreflightEvidence,
    observedAt: string
  ): Promise<SourceCapabilityRecord> {
    return this.save(sourceCapabilityRecord({
      github,
      observedAt,
      selectedBranchMode: github.linkedBranchCapability === "supported" ? "linked" : "pure_git",
      evidence: github.linkedBranchCapabilityEvidence
    }));
  }

  async load(): Promise<SourceCapabilityRecord | null> {
    const value = await readJsonFile(this.#path);
    if (value === null) return null;
    const validation = validateProtocol<SourceCapabilityRecord>("source-capability", value);
    if (!validation.ok) throw new Error(`source capability contract violation: ${validation.errors.join("; ")}`);
    return validation.value;
  }

  async remove(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}
