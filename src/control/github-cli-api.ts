import { canonicalJson } from "../protocol/canonical-json.js";
import { parseGitObjectId, type GitObjectId } from "../protocol/contracts.js";
import type { CommandRequest, CommandResult, CommandRunner } from "./command-runner.js";
import { MemoryConditionalPollStore, type ConditionalPollStore } from "./conditional-poll-store.js";
import { DEFAULT_GITHUB_CONTROL_CONFIG } from "./config.js";
import type {
  CommitStatusState,
  GitHubCommitStatusRecord,
  GitHubControlConfig,
  GitHubPreflightObservation
} from "./contracts.js";
import { GitHubControlError } from "./errors.js";
import type { GitHubApi, GitHubCommentRecord, GitHubIssueRecord } from "./github-boundary.js";
import {
  jsonArray,
  jsonBoolean,
  jsonNumber,
  jsonRecord,
  jsonString,
  parseJsonResult
} from "./github-cli-json.js";

export { FileConditionalPollStore } from "./conditional-poll-store.js";
export type { ConditionalPollStore } from "./conditional-poll-store.js";

function parseIncludedResponse(result: CommandResult): Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}> {
  if (result.exitCode !== 0) {
    throw new GitHubControlError(
      /rate.?limit|retry-after/i.test(result.stderr) ? "github_backoff" : "github_blocked_capability",
      `GitHub conditional request failed: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  const separator = result.stdout.search(/\r?\n\r?\n/);
  if (separator === -1) {
    throw new GitHubControlError("github_blocked_capability", "GitHub conditional response omitted headers");
  }
  const headerText = result.stdout.slice(0, separator);
  const bodyText = result.stdout.slice(separator).replace(/^\r?\n\r?\n/, "");
  const lines = headerText.split(/\r?\n/);
  const status = Number.parseInt(/HTTP\/\S+ ([0-9]{3})/.exec(lines[0] ?? "")?.[1] ?? "0", 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  if (status === 304) return { status, headers, body: [] };
  try {
    return { status, headers, body: JSON.parse(bodyText) as unknown };
  } catch {
    throw new GitHubControlError("github_blocked_capability", "GitHub conditional response returned invalid JSON");
  }
}

function mapIssue(value: unknown): GitHubIssueRecord {
  const issue = jsonRecord(value, "issue");
  return {
    number: jsonNumber(issue.number, "issue.number"),
    title: jsonString(issue.title, "issue.title"),
    body: issue.body === null ? "" : jsonString(issue.body, "issue.body"),
    createdAt: jsonString(issue.created_at, "issue.created_at"),
    updatedAt: jsonString(issue.updated_at, "issue.updated_at"),
    state: jsonString(issue.state, "issue.state") === "open" ? "open" : "closed",
    url: jsonString(issue.html_url, "issue.html_url"),
    labels: jsonArray(issue.labels, "issue.labels").map((label) => jsonString(jsonRecord(label, "label").name, "label.name")),
    assignees: jsonArray(issue.assignees, "issue.assignees").map((assignee) => jsonString(jsonRecord(assignee, "assignee").login, "assignee.login")),
    ...(issue.pull_request === undefined ? {} : { pullRequest: true })
  };
}

function mapComment(value: unknown): GitHubCommentRecord {
  const comment = jsonRecord(value, "issue comment");
  return {
    id: jsonNumber(comment.id, "comment.id"),
    body: jsonString(comment.body, "comment.body"),
    url: jsonString(comment.html_url, "comment.html_url")
  };
}

function mapStatus(value: unknown, fallbackSha: GitObjectId): GitHubCommitStatusRecord {
  const status = jsonRecord(value, "commit status");
  return {
    id: jsonNumber(status.id, "status.id"),
    candidateSha: status.sha === undefined
      ? fallbackSha
      : parseGitObjectId(jsonString(status.sha, "status.sha")),
    context: jsonString(status.context, "status.context"),
    state: (() => {
      const state = jsonString(status.state, "status.state");
      if (!["pending", "success", "failure", "error"].includes(state)) {
        throw new GitHubControlError("github_blocked_capability", `unsupported commit status state ${state}`);
      }
      return state as CommitStatusState;
    })(),
    description: status.description === null ? "" : jsonString(status.description, "status.description"),
    targetUrl: status.target_url === null ? "" : jsonString(status.target_url, "status.target_url"),
    url: jsonString(status.url, "status.url")
  };
}

export class GhCliGitHubApi implements GitHubApi {
  readonly #runner: CommandRunner;
  readonly #config: GitHubControlConfig;
  readonly #pollStore: ConditionalPollStore;

  constructor(input: {
    readonly runner: CommandRunner;
    readonly config?: GitHubControlConfig;
    readonly pollStore?: ConditionalPollStore;
  }) {
    this.#runner = input.runner;
    this.#config = input.config ?? DEFAULT_GITHUB_CONTROL_CONFIG;
    this.#pollStore = input.pollStore ?? new MemoryConditionalPollStore();
  }

  async preflight(): Promise<GitHubPreflightObservation> {
    const versionResult = await this.#run({ command: "gh", args: ["--version"] });
    if (versionResult.exitCode !== 0) {
      throw new GitHubControlError("github_blocked_configuration", "GitHub CLI is unavailable");
    }
    const cliVersion = /gh version ([0-9]+\.[0-9]+\.[0-9]+)/.exec(versionResult.stdout)?.[1] ?? "unknown";
    const auth = await this.#run({
      command: "gh",
      args: ["auth", "status", "--active", "--hostname", this.#config.host]
    });
    if (auth.exitCode !== 0) {
      return {
        cliVersion,
        authenticated: false,
        login: null,
        enterpriseVersion: "unknown",
        repository: this.#config.repository,
        defaultBranch: "unknown",
        issuesEnabled: false,
        permission: "none",
        labels: [],
        linkedBranchCapability: "unsupported",
        linkedBranchCapabilityEvidence: "authentication blocked before linked-branch capability probe",
        readable: {
          issues: false,
          comments: false,
          pullRequests: false,
          defaultBranchCommit: false,
          commitStatuses: false
        }
      };
    }

    const linkedBranchCapability = await this.#probeLinkedBranchCapability();
    const viewer = jsonRecord(await this.#get("/user"), "viewer");
    const meta = jsonRecord(await this.#get("/meta"), "Enterprise metadata");
    const repository = jsonRecord(await this.#get(`/repos/${this.#config.repository}`), "repository");
    const labels = jsonArray(
      await this.#getPaginated(`/repos/${this.#config.repository}/labels?per_page=100`),
      "labels"
    ).map((value) => {
      const label = jsonRecord(value, "label");
      return {
        name: jsonString(label.name, "label.name"),
        color: jsonString(label.color, "label.color"),
        description: label.description === null ? "" : jsonString(label.description, "label.description")
      };
    });
    await this.#get(`/repos/${this.#config.repository}/issues?state=open&per_page=1`);
    await this.#get(`/repos/${this.#config.repository}/issues/comments?per_page=1`);
    await this.#get(`/repos/${this.#config.repository}/pulls?state=all&per_page=1`);
    const defaultCommit = jsonRecord(
      await this.#get(`/repos/${this.#config.repository}/commits/${this.#config.defaultBranch}`),
      "default branch commit"
    );
    const defaultSha = jsonString(defaultCommit.sha, "default branch commit SHA");
    await this.#get(`/repos/${this.#config.repository}/commits/${defaultSha}/statuses?per_page=1`);

    const permissions = jsonRecord(repository.permissions, "repository.permissions");
    const permission: GitHubPreflightObservation["permission"] =
      permissions.admin === true
        ? "admin"
        : permissions.maintain === true
          ? "maintain"
          : permissions.push === true
            ? "write"
            : permissions.triage === true
              ? "triage"
              : permissions.pull === true
                ? "read"
                : "none";
    return {
      cliVersion,
      authenticated: true,
      login: jsonString(viewer.login, "viewer.login"),
      enterpriseVersion: jsonString(meta.installed_version, "meta.installed_version"),
      repository: jsonString(repository.full_name, "repository.full_name"),
      defaultBranch: jsonString(repository.default_branch, "repository.default_branch"),
      issuesEnabled: jsonBoolean(repository.has_issues, "repository.has_issues"),
      permission,
      labels,
      linkedBranchCapability: linkedBranchCapability.status,
      linkedBranchCapabilityEvidence: linkedBranchCapability.evidence,
      readable: {
        issues: true,
        comments: true,
        pullRequests: true,
        defaultBranchCommit: true,
        commitStatuses: true
      }
    };
  }

  async listReadyIssues(): Promise<readonly GitHubIssueRecord[]> {
    const endpoint = `/repos/${this.#config.repository}/issues?state=open&labels=factory%3Aready&sort=created&direction=asc&per_page=100`;
    const key = `${this.#config.host}|${this.#config.repository}|${endpoint}|${this.#config.factoryLogin}`;
    const etag = await this.#pollStore.load(key);
    const args = this.#apiArgs(endpoint, "GET", true);
    if (etag !== null) args.push("-H", `If-None-Match: ${etag}`);
    const response = parseIncludedResponse(await this.#run({ command: "gh", args }));
    const nextEtag = response.headers.etag;
    if (nextEtag !== undefined) await this.#pollStore.save(key, nextEtag);
    if (response.status === 304) return [];
    return jsonArray(response.body, "ready issues").map(mapIssue);
  }

  async getIssue(issueNumber: number): Promise<GitHubIssueRecord> {
    return mapIssue(await this.#get(`/repos/${this.#config.repository}/issues/${issueNumber}`));
  }

  async listIssueComments(issueNumber: number): Promise<readonly GitHubCommentRecord[]> {
    return jsonArray(
      await this.#getPaginated(`/repos/${this.#config.repository}/issues/${issueNumber}/comments?per_page=100`),
      "issue comments"
    ).map(mapComment);
  }

  async updateIssueClaim(input: {
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
  }): Promise<GitHubIssueRecord> {
    return mapIssue(
      await this.#requestJson(
        `/repos/${this.#config.repository}/issues/${input.issueNumber}`,
        "PATCH",
        { labels: input.labels, assignees: input.assignees }
      )
    );
  }

  async updateIssueProjection(input: {
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly state: "open" | "closed";
  }): Promise<GitHubIssueRecord> {
    return mapIssue(
      await this.#requestJson(
        `/repos/${this.#config.repository}/issues/${input.issueNumber}`,
        "PATCH",
        { labels: input.labels, assignees: input.assignees, state: input.state }
      )
    );
  }

  async createIssueComment(input: {
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<GitHubCommentRecord> {
    return mapComment(
      await this.#requestJson(
        `/repos/${this.#config.repository}/issues/${input.issueNumber}/comments`,
        "POST",
        { body: input.body }
      )
    );
  }

  async listCommitStatuses(candidateSha: GitObjectId): Promise<readonly GitHubCommitStatusRecord[]> {
    return jsonArray(
      await this.#getPaginated(`/repos/${this.#config.repository}/commits/${candidateSha}/statuses?per_page=100`),
      "commit statuses"
    ).map((status) => mapStatus(status, candidateSha));
  }

  async createCommitStatus(input: {
    readonly candidateSha: GitObjectId;
    readonly context: string;
    readonly state: CommitStatusState;
    readonly description: string;
    readonly targetUrl: string;
  }): Promise<GitHubCommitStatusRecord> {
    return mapStatus(
      await this.#requestJson(
        `/repos/${this.#config.repository}/statuses/${input.candidateSha}`,
        "POST",
        {
          state: input.state,
          context: input.context,
          description: input.description,
          target_url: input.targetUrl
        }
      ),
      input.candidateSha
    );
  }

  async #probeLinkedBranchCapability(): Promise<Readonly<{
    status: "supported" | "unsupported";
    evidence: string;
  }>> {
    const help = await this.#run({ command: "gh", args: ["issue", "develop", "--help"] });
    if (help.exitCode !== 0) {
      throw new GitHubControlError("github_blocked_configuration", "installed GitHub CLI lacks gh issue develop");
    }
    const cliSupports = help.stdout.includes("--base") && help.stdout.includes("--name") && help.stdout.includes("--list");
    const query = `query LinkedBranchCapability{issue:__type(name:"Issue"){fields{name}} mutation:__type(name:"Mutation"){fields{name}}}`;
    const result = await this.#run({
      command: "gh",
      args: ["api", "graphql", "-f", `query=${query}`]
    });
    const root = jsonRecord(parseJsonResult(result, "linked-branch capability probe"), "GraphQL response");
    const data = jsonRecord(root.data, "GraphQL capability data");
    const issueFields = jsonArray(jsonRecord(data.issue, "GraphQL Issue type").fields, "Issue fields")
      .map((field) => jsonString(jsonRecord(field, "Issue field").name, "Issue field name"));
    const mutationFields = jsonArray(jsonRecord(data.mutation, "GraphQL Mutation type").fields, "Mutation fields")
      .map((field) => jsonString(jsonRecord(field, "Mutation field").name, "Mutation field name"));
    const supported = cliSupports && issueFields.includes("linkedBranches") && mutationFields.includes("createLinkedBranch");
    return {
      status: supported ? "supported" : "unsupported",
      evidence: supported
        ? "gh issue develop flags and GHES GraphQL linkedBranches/createLinkedBranch are present"
        : "linked issue branch CLI or GHES GraphQL capability is absent"
    };
  }

  async #getPaginated(endpoint: string): Promise<readonly unknown[]> {
    const value = parseJsonResult(
      await this.#run({
        command: "gh",
        args: [...this.#apiArgs(endpoint, "GET", false), "--paginate", "--slurp"]
      }),
      `GET all pages ${endpoint}`
    );
    return jsonArray(value, `paginated ${endpoint}`).flatMap((page) =>
      jsonArray(page, `page from ${endpoint}`)
    );
  }

  async #get(endpoint: string): Promise<unknown> {
    return parseJsonResult(
      await this.#run({ command: "gh", args: this.#apiArgs(endpoint, "GET", false) }),
      `GET ${endpoint}`
    );
  }

  async #requestJson(endpoint: string, method: "POST" | "PATCH", body: unknown): Promise<unknown> {
    return parseJsonResult(
      await this.#run({
        command: "gh",
        args: [...this.#apiArgs(endpoint, method, false), "--input", "-"],
        stdin: canonicalJson(body)
      }),
      `${method} ${endpoint}`
    );
  }

  #apiArgs(endpoint: string, method: string, include: boolean): string[] {
    return [
      "api",
      "--hostname",
      this.#config.host,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${this.#config.restApiVersion}`,
      "--method",
      method,
      ...(include ? ["--include"] : []),
      endpoint
    ];
  }

  async #run(request: CommandRequest): Promise<CommandResult> {
    return this.#runner.run({
      ...request,
      env: {
        ...request.env,
        GH_HOST: this.#config.host,
        GH_REPO: `${this.#config.host}/${this.#config.repository}`,
        GH_REPO_NWO: this.#config.repository,
        GH_PROMPT_DISABLED: "1"
      }
    });
  }
}
