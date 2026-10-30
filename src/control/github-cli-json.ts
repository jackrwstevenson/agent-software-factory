import type { CommandResult } from "./command-runner.js";
import { GitHubControlError } from "./errors.js";

export function jsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubControlError("github_blocked_capability", `${label} was not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function jsonArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new GitHubControlError("github_blocked_capability", `${label} was not a JSON array`);
  }
  return value;
}

export function jsonString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GitHubControlError("github_blocked_capability", `${label} was not a string`);
  }
  return value;
}

export function jsonNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new GitHubControlError("github_blocked_capability", `${label} was not an integer`);
  }
  return value;
}

export function jsonBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubControlError("github_blocked_capability", `${label} was not a boolean`);
  }
  return value;
}

export function nullableJsonString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return jsonString(value, label);
}

export function parseJsonResult(result: CommandResult, label: string): unknown {
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    const code = /401|authentication|login/i.test(message)
      ? "github_blocked_authentication"
      : /rate.?limit|retry-after/i.test(message)
        ? "github_backoff"
        : "github_blocked_capability";
    throw new GitHubControlError(code, `${label} failed: ${message}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new GitHubControlError("github_blocked_capability", `${label} returned invalid JSON`);
  }
}
