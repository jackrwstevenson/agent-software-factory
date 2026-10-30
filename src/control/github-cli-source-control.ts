import { parseGitObjectId } from "../protocol/contracts.js";
import type { CommandResult, CommandRunner } from "./command-runner.js";
import { DEFAULT_GITHUB_CONTROL_CONFIG } from "./config.js";
import type { GitHubControlConfig, PullRequestRecord } from "./contracts.js";
import { GitHubControlError } from "./errors.js";
import type { SourceControlGitHub } from "./github-boundary.js";
import {
  jsonArray,
  jsonBoolean,
  jsonNumber,
  jsonRecord,
  jsonString,
  nullableJsonString,
  parseJsonResult
} from "./github-cli-json.js";

function mapPullRequest(value: unknown): PullRequestRecord {
  const pullRequest = jsonRecord(value, "pull request");
  const stateValue = jsonString(pullRequest.state, "pullRequest.state").toLowerCase();
  const mergeCommit = pullRequest.mergeCommit === null || pullRequest.mergeCommit === undefined
    ? null
    : jsonRecord(pullRequest.mergeCommit, "pullRequest.mergeCommit");
  const mergeOid = mergeCommit === null
    ? null
    : nullableJsonString(mergeCommit.oid, "pullRequest.mergeCommit.oid");
  return {
    number: jsonNumber(pullRequest.number, "pullRequest.number"),
    url: jsonString(pullRequest.url, "pullRequest.url"),
    state: stateValue === "merged" ? "merged" : stateValue === "open" ? "open" : "closed",
    isDraft: jsonBoolean(pullRequest.isDraft, "pullRequest.isDraft"),
    headBranch: jsonString(pullRequest.headRefName, "pullRequest.headRefName"),
    headSha: parseGitObjectId(jsonString(pullRequest.headRefOid, "pullRequest.headRefOid")),
    baseBranch: jsonString(pullRequest.baseRefName, "pullRequest.baseRefName"),
    mergeCommitSha: mergeOid === null ? null : parseGitObjectId(mergeOid)
  };
}

export class GhCliSourceControlGitHub implements SourceControlGitHub {
  readonly #runner: CommandRunner;
  readonly #config: GitHubControlConfig;

  constructor(input: { readonly runner: CommandRunner; readonly config?: GitHubControlConfig }) {
    this.#runner = input.runner;
    this.#config = input.config ?? DEFAULT_GITHUB_CONTROL_CONFIG;
  }

  async listLinkedBranches(issueNumber: number): Promise<readonly string[]> {
    const [owner, name] = this.#config.repository.split("/", 2);
    if (owner === undefined || name === undefined) {
      throw new GitHubControlError("github_blocked_configuration", "repository must be owner/name");
    }
    const query = [
      "query ListLinkedBranches($owner:String!,$name:String!,$number:Int!){",
      "repository(owner:$owner,name:$name){",
      "issue(number:$number){",
      "linkedBranches(first:30){nodes{ref{name repository{nameWithOwner}}}}",
      "}",
      "}",
      "}"
    ].join("");
    const result = await this.#gh([
      "api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`,
      "-F", `name=${name}`, "-F", `number=${issueNumber}`
    ]);
    const root = jsonRecord(parseJsonResult(result, "linked-branch GraphQL read"), "GraphQL response");
    const data = jsonRecord(root.data, "GraphQL data");
    const repository = jsonRecord(data.repository, "GraphQL repository");
    const issue = jsonRecord(repository.issue, "GraphQL issue");
    const linkedBranches = jsonRecord(issue.linkedBranches, "GraphQL linkedBranches");
    return jsonArray(linkedBranches.nodes, "GraphQL linked branch nodes").map((node) => {
      const ref = jsonRecord(jsonRecord(node, "linked branch node").ref, "linked branch ref");
      return jsonString(ref.name, "linked branch ref name");
    });
  }

  async createLinkedBranch(input: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
  }): Promise<void> {
    await this.#gh([
      "issue", "develop", String(input.issueNumber), "--repo",
      `${this.#config.host}/${this.#config.repository}`, "--base", input.baseBranch,
      "--name", input.branch
    ]);
  }

  async listPullRequests(headBranch: string): Promise<readonly PullRequestRecord[]> {
    const result = await this.#gh([
      "pr", "list", "--repo", `${this.#config.host}/${this.#config.repository}`,
      "--head", headBranch, "--state", "all", "--json",
      "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeCommit"
    ]);
    return jsonArray(parseJsonResult(result, "gh pr list"), "pull requests").map(mapPullRequest);
  }

  async createDraftPullRequest(input: Parameters<SourceControlGitHub["createDraftPullRequest"]>[0]): Promise<PullRequestRecord> {
    await this.#gh([
      "pr", "create", "--repo", `${this.#config.host}/${this.#config.repository}`,
      "--base", input.baseBranch, "--head", input.headBranch, "--title", input.title,
      "--body-file", "-", "--draft", "--no-maintainer-edit"
    ], input.body);
    const exact = (await this.listPullRequests(input.headBranch)).filter(
      (pullRequest) => pullRequest.headSha === input.headSha
    );
    if (exact.length !== 1 || exact[0] === undefined) {
      throw new GitHubControlError("github_conflict", "pull-request creation did not reconcile exactly once");
    }
    return exact[0];
  }

  async getPullRequest(number: number): Promise<PullRequestRecord> {
    const result = await this.#gh([
      "pr", "view", String(number), "--repo", `${this.#config.host}/${this.#config.repository}`,
      "--json", "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeCommit"
    ]);
    return mapPullRequest(parseJsonResult(result, "gh pr view"));
  }

  async markPullRequestReady(number: number): Promise<PullRequestRecord> {
    const current = await this.getPullRequest(number);
    if (!current.isDraft) return current;
    await this.#gh([
      "pr", "ready", String(number), "--repo",
      `${this.#config.host}/${this.#config.repository}`
    ]);
    const ready = await this.getPullRequest(number);
    if (ready.isDraft) {
      throw new GitHubControlError("github_conflict", "pull request remained draft after ready mutation");
    }
    return ready;
  }

  async requiredChecksPass(
    input: Parameters<SourceControlGitHub["requiredChecksPass"]>[0]
  ): Promise<boolean> {
    const before = await this.getPullRequest(input.number);
    if (before.headSha !== input.expectedHeadSha) {
      throw new GitHubControlError("github_conflict", "required-check read is not bound to the exact Candidate SHA");
    }
    const result = await this.#runner.run({
      command: "gh",
      args: [
        "pr", "checks", String(input.number), "--required", "--repo",
        `${this.#config.host}/${this.#config.repository}`, "--json", "bucket,name,state,link"
      ],
      env: this.#environment()
    });
    const detail = result.stderr.trim() || result.stdout.trim();
    const noRequiredChecks =
      result.exitCode === 1 &&
      /^no checks reported on the '.+' branch$/i.test(detail);
    if (result.exitCode !== 0 && result.exitCode !== 8 && !noRequiredChecks) {
      throw new GitHubControlError(
        /auth|login|401/i.test(detail) ? "github_blocked_authentication" : "github_blocked_capability",
        `gh pr checks failed (${result.exitCode}): ${detail}`
      );
    }
    let checks: readonly unknown[];
    try {
      checks = noRequiredChecks
        ? []
        : jsonArray(JSON.parse(result.stdout || "[]") as unknown, "required checks");
    } catch {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new GitHubControlError("github_blocked_capability", `gh pr checks failed: ${detail}`);
    }
    const after = await this.getPullRequest(input.number);
    if (after.headSha !== input.expectedHeadSha) {
      throw new GitHubControlError("github_conflict", "pull-request head changed during required-check read");
    }
    return checks.every((value) => {
      const bucket = jsonString(jsonRecord(value, "required check").bucket, "required check bucket");
      return bucket === "pass" || bucket === "skipping";
    });
  }

  async mergePullRequest(input: Parameters<SourceControlGitHub["mergePullRequest"]>[0]): Promise<PullRequestRecord> {
    await this.#gh([
      "pr", "merge", String(input.number), "--repo",
      `${this.#config.host}/${this.#config.repository}`, "--merge",
      "--match-head-commit", input.expectedHeadSha
    ]);
    return this.getPullRequest(input.number);
  }

  async closePullRequest(number: number): Promise<PullRequestRecord> {
    const current = await this.getPullRequest(number);
    if (current.state !== "open") return current;
    await this.#gh([
      "pr", "close", String(number), "--repo",
      `${this.#config.host}/${this.#config.repository}`
    ]);
    const closed = await this.getPullRequest(number);
    if (closed.state === "open") {
      throw new GitHubControlError("github_conflict", "pull request remained open after close mutation");
    }
    return closed;
  }

  #environment(): Readonly<Record<string, string>> {
    return {
      GH_HOST: this.#config.host,
      GH_REPO: `${this.#config.host}/${this.#config.repository}`,
      GH_REPO_NWO: this.#config.repository,
      GH_PROMPT_DISABLED: "1"
    };
  }

  async #gh(args: readonly string[], stdin?: string): Promise<CommandResult> {
    const result = await this.#runner.run({
      command: "gh",
      args,
      ...(stdin === undefined ? {} : { stdin }),
      env: this.#environment()
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      const code = /auth|login|401/i.test(detail)
        ? "github_blocked_authentication"
        : /rate.?limit|retry-after|timeout|timed out|5\d\d|service unavailable|temporarily unavailable/i.test(detail)
          ? "github_backoff"
          : "github_blocked_capability";
      throw new GitHubControlError(code, `gh ${args.join(" ")} failed: ${detail}`);
    }
    return result;
  }
}
