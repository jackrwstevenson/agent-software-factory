import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitSourceControl,
  ProcessCommandRunner,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type PullRequestRecord,
  type SourceControlConfig,
  type SourceControlGitHub
} from "../../src/control/source-control.js";
import {
  parseDigest,
  parseEffectIntentId,
  parseFactoryRunId,
  parseGitObjectId,
  parseStageAttemptId,
  type GitObjectId
} from "../../src/protocol/contracts.js";

async function git(runner: ProcessCommandRunner, cwd: string, ...args: string[]): Promise<string> {
  const result = await runner.run({ command: "git", args, cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

class InMemoryPullRequests implements SourceControlGitHub {
  readonly pullRequests: PullRequestRecord[] = [];
  requiredChecks = true;
  closeCount = 0;

  async listLinkedBranches(): Promise<readonly string[]> {
    return [];
  }

  async createLinkedBranch(_input: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
  }): Promise<void> {
    throw new Error("linked branch mode is disabled");
  }

  async listPullRequests(headBranch: string): Promise<readonly PullRequestRecord[]> {
    return this.pullRequests.filter((pullRequest) => pullRequest.headBranch === headBranch);
  }

  async createDraftPullRequest(input: {
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    const pullRequest = {
      number: 101,
      url: "https://github.org.com/pr/101",
      state: "open" as const,
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
    const pullRequest = await this.getPullRequest(number);
    const ready = { ...pullRequest, isDraft: false };
    const index = this.pullRequests.findIndex((candidate) => candidate.number === number);
    this.pullRequests.splice(index, 1, ready);
    return ready;
  }

  async requiredChecksPass(): Promise<boolean> {
    return this.requiredChecks;
  }

  async mergePullRequest(_input: {
    readonly number: number;
    readonly expectedHeadSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    throw new Error("not used by this test");
  }

  async closePullRequest(number: number): Promise<PullRequestRecord> {
    const pullRequest = await this.getPullRequest(number);
    this.closeCount += 1;
    const closed = { ...pullRequest, state: "closed" as const, isDraft: false };
    const index = this.pullRequests.findIndex((candidate) => candidate.number === number);
    this.pullRequests.splice(index, 1, closed);
    return closed;
  }
}

async function createRepository(): Promise<Readonly<{
  root: string;
  primary: string;
  remote: string;
  stateRoot: string;
  baseSha: string;
  runner: ProcessCommandRunner;
}>> {
  const root = await mkdtemp(join(tmpdir(), "factory-source-"));
  const remote = join(root, "origin.git");
  const primary = join(root, "primary");
  const stateRoot = join(root, "state");
  const runner = new ProcessCommandRunner();
  await git(runner, root, "init", "--bare", remote);
  await git(runner, root, "init", "--initial-branch=main", primary);
  await writeFile(join(primary, "README.md"), "baseline\n", "utf8");
  await git(runner, primary, "add", "README.md");
  await git(runner, primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline");
  await git(runner, primary, "remote", "add", "origin", remote);
  await git(runner, primary, "push", "-u", "origin", "main");
  await git(runner, primary, "remote", "set-head", "origin", "main");
  const baseSha = await git(runner, primary, "rev-parse", "HEAD");
  return { root, primary, remote, stateRoot, baseSha, runner };
}

const context = {
  effectIntentId: parseEffectIntentId("fx_source_001"),
  factoryRunId: parseFactoryRunId("fr_source_001")
} as const;

test("Factory Worktree candidate creation leaves a dirty primary checkout untouched", async () => {
  const repository = await createRepository();
  try {
    await writeFile(join(repository.primary, "README.md"), "human work\n", "utf8");
    const github = new InMemoryPullRequests();
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: {
        repositoryRoot: repository.primary,
        stateRoot: repository.stateRoot,
        remoteName: "origin",
        expectedRemoteUrl: repository.remote,
        defaultBranch: "main",
        repository: "github.org.com/engineering/agentic-software-factory",
        branchMode: "pure_git",
        branchModeEvidence: "test classified linked branches unsupported",
        expectedGitVersion: "2.47.1",
        expectedGitHubCliVersion: "2.96.0"
      }
    });

    const preflight = await sourceControl.preflight();
    assert.equal(preflight.defaultBranchSha, repository.baseSha);
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: preflight.defaultBranchSha
    });
    assert.equal(prepared.branchMode, "pure_git");
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");

    const candidate = await sourceControl.createCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_001"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready",
        stageAttemptId: parseStageAttemptId("fa_builder_001"),
        builderEvidenceDigest: parseDigest("a".repeat(64)),
        summary: "Create the candidate file"
      }
    });

    assert.match(candidate.headCommitSha, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.equal(candidate.baseSha, repository.baseSha);
    assert.equal(await readFile(join(repository.primary, "README.md"), "utf8"), "human work\n");
    assert.equal(await git(repository.runner, repository.primary, "branch", "--show-current"), "main");
    assert.equal(await git(repository.runner, repository.primary, "status", "--porcelain=v1"), "M README.md");
    assert.equal(github.pullRequests.length, 1);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});


function configFor(repository: Readonly<{
  primary: string;
  remote: string;
  stateRoot: string;
}>): SourceControlConfig {
  return {
    repositoryRoot: repository.primary,
    stateRoot: repository.stateRoot,
    remoteName: "origin",
    expectedRemoteUrl: repository.remote,
    defaultBranch: "main",
    repository: "github.org.com/engineering/agentic-software-factory",
    branchMode: "pure_git",
    branchModeEvidence: "test classified linked branches unsupported",
    expectedGitVersion: "2.47.1",
    expectedGitHubCliVersion: "2.96.0"
  };
}

class CrashAfterPushRunner implements CommandRunner {
  armed = false;
  crashed = false;
  readonly #delegate: CommandRunner;

  constructor(delegate: CommandRunner) {
    this.#delegate = delegate;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const result = await this.#delegate.run(request);
    if (
      this.armed &&
      !this.crashed &&
      result.exitCode === 0 &&
      request.command === "git" &&
      request.args.includes("push")
    ) {
      this.crashed = true;
      throw new Error("injected crash after Git push");
    }
    return result;
  }
}

class CrashAfterPullRequest extends InMemoryPullRequests {
  crashAfterCreate = true;
  createCount = 0;

  override async createDraftPullRequest(input: {
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    this.createCount += 1;
    const pullRequest = await super.createDraftPullRequest(input);
    if (this.crashAfterCreate) {
      this.crashAfterCreate = false;
      throw new Error("injected crash after pull-request creation");
    }
    return pullRequest;
  }
}

test("a crash after the fallback branch push adopts the one remote Factory Branch", async () => {
  const repository = await createRepository();
  try {
    const crashRunner = new CrashAfterPushRunner(repository.runner);
    crashRunner.armed = true;
    const github = new InMemoryPullRequests();
    const first = new GitSourceControl({ runner: crashRunner, github, config: configFor(repository) });
    const baseSha = parseGitObjectId(repository.baseSha);

    await assert.rejects(
      first.prepareRun({ context, issueNumber: 41, baseSha }),
      /injected crash/
    );

    const restarted = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await restarted.prepareRun({ context, issueNumber: 41, baseSha });
    const remoteRefs = await git(
      repository.runner,
      repository.primary,
      "ls-remote",
      "--heads",
      "origin",
      prepared.branchRef
    );
    assert.equal(prepared.branchMode, "pure_git");
    assert.equal(remoteRefs.split("\n").filter(Boolean).length, 1);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("a crash after pull-request creation reconciles the one PR and Candidate", async () => {
  const repository = await createRepository();
  try {
    const github = new CrashAfterPullRequest();
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    const candidateInput = {
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_001"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready" as const,
        stageAttemptId: parseStageAttemptId("fa_builder_001"),
        builderEvidenceDigest: parseDigest("a".repeat(64)),
        summary: "Create the candidate file"
      }
    };

    await assert.rejects(sourceControl.createCandidate(candidateInput), /injected crash/);
    const candidate = await sourceControl.createCandidate(candidateInput);

    assert.match(candidate.headCommitSha, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.equal(github.createCount, 1);
    assert.equal(github.pullRequests.length, 1);
    assert.equal(github.pullRequests[0]?.headSha, candidate.headCommitSha);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("a crash after Candidate push adopts the pushed SHA before creating one PR", async () => {
  const repository = await createRepository();
  try {
    const crashRunner = new CrashAfterPushRunner(repository.runner);
    const github = new InMemoryPullRequests();
    const sourceControl = new GitSourceControl({
      runner: crashRunner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    crashRunner.armed = true;
    const candidateInput = {
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_001"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready" as const,
        stageAttemptId: parseStageAttemptId("fa_builder_001"),
        builderEvidenceDigest: parseDigest("a".repeat(64)),
        summary: "Create the candidate file"
      }
    };

    await assert.rejects(sourceControl.createCandidate(candidateInput), /injected crash after Git push/);
    const candidate = await sourceControl.createCandidate(candidateInput);
    const remote = await git(
      repository.runner,
      repository.primary,
      "ls-remote",
      "origin",
      prepared.branchRef
    );

    assert.equal(remote.split(/\s+/, 1)[0], candidate.headCommitSha);
    assert.equal(github.pullRequests.length, 1);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

class CrashAfterLinkedBranch extends InMemoryPullRequests {
  readonly linked = new Set<string>();
  createCount = 0;
  crashAfterCreate = true;
  readonly #runner: ProcessCommandRunner;
  readonly #primary: string;

  constructor(runner: ProcessCommandRunner, primary: string) {
    super();
    this.#runner = runner;
    this.#primary = primary;
  }

  override async listLinkedBranches(): Promise<readonly string[]> {
    return [...this.linked];
  }

  override async createLinkedBranch(input: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
  }): Promise<void> {
    this.createCount += 1;
    await git(
      this.#runner,
      this.#primary,
      "push",
      "origin",
      `refs/heads/main:refs/heads/${input.branch}`
    );
    this.linked.add(input.branch);
    if (this.crashAfterCreate) {
      this.crashAfterCreate = false;
      throw new Error("injected crash after linked-branch creation");
    }
  }
}

test("a crash after issue-linked branch creation adopts the one linked branch", async () => {
  const repository = await createRepository();
  try {
    const github = new CrashAfterLinkedBranch(repository.runner, repository.primary);
    const config = {
      ...configFor(repository),
      branchMode: "linked" as const,
      branchModeEvidence: "test capability probe supports linked branches"
    };
    const sourceControl = new GitSourceControl({ runner: repository.runner, github, config });
    const baseSha = parseGitObjectId(repository.baseSha);

    await assert.rejects(
      sourceControl.prepareRun({ context, issueNumber: 41, baseSha }),
      /injected crash after linked-branch creation/
    );
    const prepared = await sourceControl.prepareRun({ context, issueNumber: 41, baseSha });

    assert.equal(prepared.branchMode, "linked");
    assert.equal(github.createCount, 1);
    assert.deepEqual([...github.linked], [prepared.branchName]);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("pull-request reads reject abbreviated Candidate SHAs", async () => {
  const github = new InMemoryPullRequests();
  const fullSha = parseGitObjectId("1234567890abcdef1234567890abcdef12345678");
  github.pullRequests.push({
    number: 101,
    url: "https://github.org.com/pr/101",
    state: "open",
    isDraft: true,
    headBranch: "factory/issue-41/fr_source_001",
    headSha: fullSha,
    baseBranch: "main",
    mergeCommitSha: null
  });
  const sourceControl = new GitSourceControl({
    runner: new ProcessCommandRunner(),
    github,
    config: {
      repositoryRoot: "/unused",
      stateRoot: "/unused",
      remoteName: "origin",
      expectedRemoteUrl: "unused",
      defaultBranch: "main",
      repository: "github.org.com/engineering/agentic-software-factory",
      branchMode: "pure_git",
      branchModeEvidence: "test classified linked branches unsupported",
      expectedGitVersion: "2.47.1",
      expectedGitHubCliVersion: "2.96.0"
    }
  });

  await assert.rejects(
    sourceControl.readPullRequest({ number: 101, expectedHeadSha: "1234567" as GitObjectId }),
    /full Git object ID/
  );
  const pullRequest = await sourceControl.readPullRequest({ number: 101, expectedHeadSha: fullSha });
  assert.equal(pullRequest.headSha, fullSha);
});

class MergingPullRequests extends InMemoryPullRequests {
  mergeCount = 0;
  crashAfterMerge = true;
  readonly #runner: ProcessCommandRunner;
  readonly #remote: string;
  readonly #root: string;

  constructor(runner: ProcessCommandRunner, remote: string, root: string) {
    super();
    this.#runner = runner;
    this.#remote = remote;
    this.#root = root;
  }

  override async mergePullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    this.mergeCount += 1;
    const pullRequest = await this.getPullRequest(input.number);
    assert.equal(pullRequest.headSha, input.expectedHeadSha);
    const integration = join(this.#root, `integration-${this.mergeCount}`);
    await git(this.#runner, this.#root, "clone", "--branch", "main", this.#remote, integration);
    await git(this.#runner, integration, "fetch", "origin", pullRequest.headBranch);
    await git(
      this.#runner,
      integration,
      "-c",
      "user.name=Fixture Merger",
      "-c",
      "user.email=merger@example.test",
      "merge",
      "--no-ff",
      "--no-edit",
      `origin/${pullRequest.headBranch}`
    );
    const mergeCommitSha = parseGitObjectId(
      await git(this.#runner, integration, "rev-parse", "HEAD")
    );
    await git(this.#runner, integration, "push", "origin", "HEAD:refs/heads/main");
    const merged = { ...pullRequest, state: "merged" as const, isDraft: false, mergeCommitSha };
    const index = this.pullRequests.findIndex((candidate) => candidate.number === input.number);
    this.pullRequests.splice(index, 1, merged);
    if (this.crashAfterMerge) {
      this.crashAfterMerge = false;
      throw new Error("injected crash after exact-head merge");
    }
    return merged;
  }
}

test("exact-tree integration reconciles a crash after merge without merging twice", async () => {
  const repository = await createRepository();
  try {
    const github = new MergingPullRequests(repository.runner, repository.remote, repository.root);
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    const candidate = await sourceControl.createCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_001"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready",
        stageAttemptId: parseStageAttemptId("fa_builder_001"),
        builderEvidenceDigest: parseDigest("a".repeat(64)),
        summary: "Create the candidate file"
      }
    });

    await sourceControl.readyCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_ready_001"),
        factoryRunId: context.factoryRunId
      },
      candidate
    });
    await assert.rejects(
      sourceControl.integrateCandidate({
        context: {
          effectIntentId: parseEffectIntentId("fx_integrate_001"),
          factoryRunId: context.factoryRunId
        },
        candidate,
        pullRequestNumber: 101
      }),
      /injected crash after exact-head merge/
    );
    const integration = await sourceControl.integrateCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_integrate_001"),
        factoryRunId: context.factoryRunId
      },
      candidate,
      pullRequestNumber: 101
    });

    assert.equal(integration.sourceTreeSha, candidate.sourceTreeSha);
    assert.equal(github.mergeCount, 1);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("startup preflight ignores historical branches and reconciles the durable run's worktree", async () => {
  const repository = await createRepository();
  try {
    const github = new InMemoryPullRequests();
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    await sourceControl.preflight();
    await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });

    const historical = await sourceControl.preflight();
    assert.equal(historical.defaultBranchSha, repository.baseSha);
    const reconciled = await sourceControl.preflight({
      knownFactoryRunId: context.factoryRunId,
      knownIssueNumber: 41
    });
    assert.equal(reconciled.defaultBranchSha, repository.baseSha);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});


test("exact-tree integration refuses to merge until required checks pass", async () => {
  const repository = await createRepository();
  try {
    const github = new MergingPullRequests(repository.runner, repository.remote, repository.root);
    github.requiredChecks = false;
    github.crashAfterMerge = false;
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    const candidate = await sourceControl.createCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_checks"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready",
        stageAttemptId: parseStageAttemptId("fa_builder_checks"),
        builderEvidenceDigest: parseDigest("b".repeat(64)),
        summary: "Create the candidate file"
      }
    });

    await sourceControl.readyCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_ready_checks"),
        factoryRunId: context.factoryRunId
      },
      candidate
    });
    await assert.rejects(
      sourceControl.integrateCandidate({
        context: {
          effectIntentId: parseEffectIntentId("fx_integrate_checks"),
          factoryRunId: context.factoryRunId
        },
        candidate,
        pullRequestNumber: 101
      }),
      /required checks have not passed/
    );
    assert.equal(github.mergeCount, 0);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("succeeded terminal cleanup removes only the exact clean run assets and adopts retries", async () => {
  const repository = await createRepository();
  try {
    const github = new InMemoryPullRequests();
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    const candidate = await sourceControl.createCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_cleanup_success"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready",
        stageAttemptId: parseStageAttemptId("fa_builder_cleanup_success"),
        builderEvidenceDigest: parseDigest("c".repeat(64)),
        summary: "Create the cleanup candidate"
      }
    });
    const pullRequest = github.pullRequests[0];
    assert.ok(pullRequest !== undefined);
    github.pullRequests.splice(0, 1, {
      ...pullRequest,
      state: "merged",
      isDraft: false,
      mergeCommitSha: parseGitObjectId("f".repeat(40))
    });
    const input = {
      context: {
        effectIntentId: parseEffectIntentId("fx_terminal_cleanup_success"),
        factoryRunId: context.factoryRunId
      },
      issueNumber: 41,
      terminalOutcome: "succeeded" as const,
      candidate
    };

    const first = await sourceControl.cleanupTerminal(input);
    const adopted = await sourceControl.cleanupTerminal(input);

    assert.deepEqual(adopted, first);
    assert.deepEqual(first, {
      schemaVersion: "1.0",
      contract: "terminal_cleanup_receipt",
      status: "complete",
      terminalOutcome: "succeeded",
      worktree: { state: "absent" },
      localBranch: { state: "absent", sha: null },
      remoteBranch: { state: "absent", sha: null },
      pullRequest: { state: "merged", number: 101, headSha: candidate.headCommitSha }
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(repository.stateRoot, "runs", context.factoryRunId, "terminal-cleanup.json"), "utf8")),
      first
    );
    await assert.rejects(stat(prepared.worktreePath), /ENOENT/);
    const local = await repository.runner.run({
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", prepared.branchRef],
      cwd: repository.primary
    });
    assert.equal(local.exitCode, 1);
    assert.equal(
      await git(repository.runner, repository.primary, "ls-remote", "--heads", "origin", prepared.branchRef),
      ""
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("non-success terminal cleanup closes an unmerged PR but records dirty worktree pending cleanup", async () => {
  const repository = await createRepository();
  try {
    const github = new InMemoryPullRequests();
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    const candidate = await sourceControl.createCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_cleanup_failed"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready",
        stageAttemptId: parseStageAttemptId("fa_builder_cleanup_failed"),
        builderEvidenceDigest: parseDigest("d".repeat(64)),
        summary: "Create the pending-cleanup candidate"
      }
    });
    await writeFile(join(prepared.worktreePath, "operator-notes.txt"), "preserve me\n", "utf8");
    const input = {
      context: {
        effectIntentId: parseEffectIntentId("fx_terminal_cleanup_failed"),
        factoryRunId: context.factoryRunId
      },
      issueNumber: 41,
      terminalOutcome: "failed" as const,
      candidate
    };

    const first = await sourceControl.cleanupTerminal(input);
    const adopted = await sourceControl.cleanupTerminal(input);

    assert.deepEqual(adopted, first);
    assert.deepEqual(first, {
      schemaVersion: "1.0",
      contract: "terminal_cleanup_receipt",
      status: "pending_cleanup",
      terminalOutcome: "failed",
      worktree: {
        state: "locked",
        path: prepared.worktreePath,
        branchRef: prepared.branchRef,
        headSha: candidate.headCommitSha,
        dirty: true
      },
      localBranch: { state: "present", sha: candidate.headCommitSha },
      remoteBranch: { state: "present", sha: candidate.headCommitSha },
      pullRequest: { state: "closed", number: 101, headSha: candidate.headCommitSha },
      reason: "Factory Worktree is dirty"
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(repository.stateRoot, "runs", context.factoryRunId, "terminal-cleanup.json"), "utf8")),
      first
    );
    assert.equal(github.closeCount, 1);
    assert.equal(github.pullRequests[0]?.state, "closed");
    assert.equal(await readFile(join(prepared.worktreePath, "operator-notes.txt"), "utf8"), "preserve me\n");
    const worktrees = await git(repository.runner, repository.primary, "worktree", "list", "--porcelain");
    assert.match(worktrees, new RegExp(`worktree ${prepared.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*locked`));
    assert.equal(
      await git(repository.runner, repository.primary, "ls-remote", "--heads", "origin", prepared.branchRef),
      `${candidate.headCommitSha}\t${prepared.branchRef}`
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("a non-success Terminal Outcome fails closed when its exact PR is already merged", async () => {
  const repository = await createRepository();
  try {
    const github = new InMemoryPullRequests();
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github,
      config: configFor(repository)
    });
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });
    await writeFile(join(prepared.worktreePath, "feature.txt"), "candidate\n", "utf8");
    const candidate = await sourceControl.createCandidate({
      context: {
        effectIntentId: parseEffectIntentId("fx_candidate_cleanup_merged_conflict"),
        factoryRunId: context.factoryRunId
      },
      prepared,
      issueNumber: 41,
      candidateOrdinal: 1,
      previousCandidateHeadSha: null,
      build: {
        decision: "changes_ready",
        stageAttemptId: parseStageAttemptId("fa_builder_cleanup_merged_conflict"),
        builderEvidenceDigest: parseDigest("e".repeat(64)),
        summary: "Create the merged-conflict candidate"
      }
    });
    const pullRequest = github.pullRequests[0];
    assert.ok(pullRequest !== undefined);
    github.pullRequests.splice(0, 1, {
      ...pullRequest,
      state: "merged",
      isDraft: false,
      mergeCommitSha: parseGitObjectId("f".repeat(40))
    });

    await assert.rejects(
      sourceControl.cleanupTerminal({
        context: {
          effectIntentId: parseEffectIntentId("fx_terminal_cleanup_merged_conflict"),
          factoryRunId: context.factoryRunId
        },
        issueNumber: 41,
        terminalOutcome: "failed",
        candidate
      }),
      /non-success Terminal Outcome conflicts with an already-merged pull request/
    );

    const receipt = JSON.parse(
      await readFile(join(repository.stateRoot, "runs", context.factoryRunId, "terminal-cleanup.json"), "utf8")
    );
    assert.deepEqual(receipt, {
      schemaVersion: "1.0",
      contract: "terminal_cleanup_receipt",
      status: "pending_cleanup",
      terminalOutcome: "failed",
      worktree: {
        state: "locked",
        path: prepared.worktreePath,
        branchRef: prepared.branchRef,
        headSha: candidate.headCommitSha,
        dirty: false
      },
      localBranch: { state: "present", sha: candidate.headCommitSha },
      remoteBranch: { state: "present", sha: candidate.headCommitSha },
      pullRequest: { state: "merged", number: 101, headSha: candidate.headCommitSha },
      reason: "non-success Terminal Outcome conflicts with an already-merged pull request"
    });
    assert.equal(github.closeCount, 0);
    assert.equal(github.pullRequests[0]?.state, "merged");
    assert.equal(await readFile(join(prepared.worktreePath, "feature.txt"), "utf8"), "candidate\n");
    assert.equal(
      await git(repository.runner, repository.primary, "ls-remote", "--heads", "origin", prepared.branchRef),
      `${candidate.headCommitSha}\t${prepared.branchRef}`
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});

test("terminal branch observation reports only an exact remote branch that exists", async () => {
  const repository = await createRepository();
  try {
    const sourceControl = new GitSourceControl({
      runner: repository.runner,
      github: new InMemoryPullRequests(),
      config: configFor(repository)
    });

    assert.deepEqual(
      await sourceControl.observeTerminalBranch({ context, issueNumber: 41 }),
      { state: "absent" }
    );
    const prepared = await sourceControl.prepareRun({
      context,
      issueNumber: 41,
      baseSha: parseGitObjectId(repository.baseSha)
    });

    assert.deepEqual(
      await sourceControl.observeTerminalBranch({ context, issueNumber: 41 }),
      {
        state: "present",
        branchRef: prepared.branchRef,
        remoteSha: parseGitObjectId(repository.baseSha)
      }
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
  }
});
