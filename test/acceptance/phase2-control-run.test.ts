import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REQUIRED_FACTORY_LABELS } from "../../src/control/config.js";
import type { GitHubApi, GitHubCommentRecord, GitHubIssueRecord, SourceControlGitHub } from "../../src/control/github-boundary.js";
import { FileClaimIntentStore, RecoverableGitHubControl } from "../../src/control/github-control.js";
import { GitSourceControl, ProcessCommandRunner, type PullRequestRecord } from "../../src/control/source-control.js";
import type { GitHubCommitStatusRecord } from "../../src/control/contracts.js";
import { FileRunStore } from "../../src/journal/file-run-store.js";
import { createPhase2FakeLaterAdapters } from "../../src/orchestrator/phase2-fakes.js";
import { runOnceFactory } from "../../src/orchestrator/run-once.js";
import { parseGitObjectId, type GitObjectId } from "../../src/protocol/contracts.js";

async function git(runner: ProcessCommandRunner, cwd: string, ...args: string[]): Promise<string> {
  const result = await runner.run({ command: "git", args, cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

class Phase2GitHub implements GitHubApi, SourceControlGitHub {
  readonly issue: GitHubIssueRecord = {
    number: 41,
    title: "Phase 2 walking skeleton",
    body: "- [ ] exercise real control adapters",
    createdAt: "2026-09-28T08:00:00.000Z",
    updatedAt: "2026-09-28T08:00:00.000Z",
    state: "open",
    url: "https://github.org.com/issues/41",
    labels: ["factory:ready"],
    assignees: []
  };
  readonly comments: GitHubCommentRecord[] = [];
  readonly statuses: GitHubCommitStatusRecord[] = [];
  readonly pullRequests: PullRequestRecord[] = [];
  claimMutations = 0;
  terminalMutations = 0;
  closeCount = 0;
  readonly #runner: ProcessCommandRunner;
  readonly #remote: string;
  readonly #root: string;

  constructor(runner: ProcessCommandRunner, remote: string, root: string) {
    this.#runner = runner;
    this.#remote = remote;
    this.#root = root;
  }

  async preflight() {
    return {
      cliVersion: "2.96.0",
      authenticated: true,
      login: "GH_ENTERPRISE_USERNAME",
      enterpriseVersion: "3.19.10",
      repository: "engineering/agentic-software-factory",
      defaultBranch: "main",
      issuesEnabled: true,
      permission: "admin" as const,
      labels: REQUIRED_FACTORY_LABELS,
      linkedBranchCapability: "unsupported" as const,
      linkedBranchCapabilityEvidence: "fixture GraphQL capability probe classified linked branches unsupported",
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
    return [structuredClone(this.issue)];
  }

  async getIssue(): Promise<GitHubIssueRecord> {
    return structuredClone(this.issue);
  }

  async listIssueComments(): Promise<readonly GitHubCommentRecord[]> {
    return structuredClone(this.comments);
  }

  async updateIssueClaim(input: {
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
  }): Promise<GitHubIssueRecord> {
    this.claimMutations += 1;
    this.issue.labels = [...input.labels];
    this.issue.assignees = [...input.assignees];
    return structuredClone(this.issue);
  }

  async updateIssueProjection(input: {
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly state: "open" | "closed";
  }): Promise<GitHubIssueRecord> {
    this.terminalMutations += 1;
    this.issue.labels = [...input.labels];
    this.issue.assignees = [...input.assignees];
    this.issue.state = input.state;
    return structuredClone(this.issue);
  }

  async createIssueComment(input: { readonly body: string }): Promise<GitHubCommentRecord> {
    const comment = {
      id: this.comments.length + 1,
      body: input.body,
      url: `https://github.org.com/comment/${this.comments.length + 1}`
    };
    this.comments.push(comment);
    return comment;
  }

  async listCommitStatuses(candidateSha: GitObjectId): Promise<readonly GitHubCommitStatusRecord[]> {
    return this.statuses.filter((status) => status.candidateSha === candidateSha);
  }

  async createCommitStatus(input: {
    readonly candidateSha: GitObjectId;
    readonly context: string;
    readonly state: "pending" | "success" | "failure" | "error";
    readonly description: string;
    readonly targetUrl: string;
  }): Promise<GitHubCommitStatusRecord> {
    const status = {
      id: this.statuses.length + 1,
      candidateSha: input.candidateSha,
      context: input.context,
      state: input.state,
      description: input.description,
      targetUrl: input.targetUrl,
      url: `https://github.org.com/status/${this.statuses.length + 1}`
    };
    this.statuses.push(status);
    return status;
  }

  async listLinkedBranches(): Promise<readonly string[]> {
    return [];
  }

  async createLinkedBranch(): Promise<void> {
    throw new Error("pure-Git fallback selected");
  }

  async listPullRequests(headBranch: string): Promise<readonly PullRequestRecord[]> {
    return this.pullRequests.filter((pullRequest) => pullRequest.headBranch === headBranch);
  }

  async createDraftPullRequest(input: {
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    const pullRequest: PullRequestRecord = {
      number: 101,
      url: "https://github.org.com/pr/101",
      state: "open",
      isDraft: true,
      headBranch: input.headBranch,
      headSha: input.headSha,
      baseBranch: input.baseBranch,
      mergeCommitSha: null
    };
    this.pullRequests.push(pullRequest);
    return pullRequest;
  }

  async getPullRequest(number: number): Promise<PullRequestRecord> {
    const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
    if (pullRequest === undefined) throw new Error(`missing PR ${number}`);
    return pullRequest;
  }

  async markPullRequestReady(number: number): Promise<PullRequestRecord> {
    const current = await this.getPullRequest(number);
    const ready = { ...current, isDraft: false };
    this.pullRequests.splice(0, 1, ready);
    return ready;
  }

  async requiredChecksPass(): Promise<boolean> {
    return true;
  }

  async mergePullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    const current = await this.getPullRequest(input.number);
    assert.equal(current.headSha, input.expectedHeadSha);
    const checkout = join(this.#root, "integration");
    await git(this.#runner, this.#root, "clone", "--branch", "main", this.#remote, checkout);
    await git(this.#runner, checkout, "fetch", "origin", current.headBranch);
    await git(
      this.#runner,
      checkout,
      "-c",
      "user.name=Fixture Merger",
      "-c",
      "user.email=merger@example.test",
      "merge",
      "--no-ff",
      "--no-edit",
      `origin/${current.headBranch}`
    );
    const mergeCommitSha = parseGitObjectId(await git(this.#runner, checkout, "rev-parse", "HEAD"));
    await git(this.#runner, checkout, "push", "origin", "HEAD:refs/heads/main");
    const merged = { ...current, state: "merged" as const, mergeCommitSha };
    this.pullRequests.splice(0, 1, merged);
    return merged;
  }

  async closePullRequest(number: number): Promise<PullRequestRecord> {
    const current = await this.getPullRequest(number);
    if (current.state !== "open") return current;
    this.closeCount += 1;
    const closed = { ...current, state: "closed" as const, isDraft: false };
    this.pullRequests.splice(0, 1, closed);
    return closed;
  }
}

test("Phase 2 composes real control adapters with fake later adapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-phase2-run-"));
  try {
    const runner = new ProcessCommandRunner();
    const remote = join(root, "origin.git");
    const primary = join(root, "primary");
    const stateRoot = join(root, "state");
    await git(runner, root, "init", "--bare", remote);
    await git(runner, root, "init", "--initial-branch=main", primary);
    await writeFile(join(primary, "README.md"), "baseline\n", "utf8");
    await git(runner, primary, "add", "README.md");
    await git(runner, primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline");
    await git(runner, primary, "remote", "add", "origin", remote);
    await git(runner, primary, "push", "-u", "origin", "main");
    await git(runner, primary, "remote", "set-head", "origin", "main");
    await writeFile(join(primary, "README.md"), "uncommitted human work\n", "utf8");

    const githubBoundary = new Phase2GitHub(runner, remote, root);
    const githubControl = new RecoverableGitHubControl({
      api: githubBoundary,
      claimStore: new FileClaimIntentStore(join(stateRoot, "control", "claim-intent.json"))
    });
    const sourceControl = new GitSourceControl({
      runner,
      github: githubBoundary,
      config: {
        repositoryRoot: primary,
        stateRoot,
        remoteName: "origin",
        expectedRemoteUrl: remote,
        defaultBranch: "main",
        repository: "github.org.com/engineering/agentic-software-factory",
        branchMode: "pure_git",
        branchModeEvidence: "fixture capability probe classified linked branches unsupported",
        expectedGitVersion: "2.47.1",
        expectedGitHubCliVersion: "2.96.0"
      }
    });
    const snapshot = await runOnceFactory({
      store: new FileRunStore(join(stateRoot, "runs", "phase2-active")),
      githubControl,
      sourceControl,
      ...createPhase2FakeLaterAdapters()
    });
    const replayed = await runOnceFactory({
      store: new FileRunStore(join(stateRoot, "runs", "phase2-active")),
      githubControl,
      sourceControl,
      ...createPhase2FakeLaterAdapters()
    });

    assert.equal(snapshot.state.terminalOutcome, "succeeded");
    assert.deepEqual(replayed, snapshot);
    assert.equal(githubBoundary.claimMutations, 1);
    assert.equal(githubBoundary.terminalMutations, 1);
    assert.equal(githubBoundary.pullRequests.length, 1);
    assert.equal(githubBoundary.pullRequests[0]?.state, "merged");
    assert.equal(githubBoundary.issue.state, "closed");
    assert.deepEqual(githubBoundary.issue.labels, ["factory:succeeded"]);
    assert.equal(
      githubBoundary.comments.filter((comment) => comment.body.includes("event=run.terminal")).length,
      1
    );
    const candidate = snapshot.state.candidate;
    assert.ok(candidate !== null);
    assert.deepEqual(githubBoundary.statuses, [{
      id: 1,
      candidateSha: candidate.headCommitSha,
      context: "factory/rollout",
      state: "success",
      description: "Factory Run Succeeded",
      targetUrl: githubBoundary.comments.find((comment) => comment.body.includes("event=run.terminal"))?.url,
      url: "https://github.org.com/status/1"
    }]);
    await assert.rejects(
      stat(join(stateRoot, "runs", candidate.factoryRunId, "worktree")),
      /ENOENT/
    );
    assert.equal(
      await git(runner, primary, "ls-remote", "--heads", "origin", candidate.branchRef),
      ""
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(stateRoot, "runs", candidate.factoryRunId, "terminal-cleanup.json"), "utf8")),
      {
        schemaVersion: "1.0",
        contract: "terminal_cleanup_receipt",
        status: "complete",
        terminalOutcome: "succeeded",
        worktree: { state: "absent" },
        localBranch: { state: "absent", sha: null },
        remoteBranch: { state: "absent", sha: null },
        pullRequest: { state: "merged", number: 101, headSha: candidate.headCommitSha }
      }
    );
    assert.equal(await readFile(join(primary, "README.md"), "utf8"), "uncommitted human work\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
