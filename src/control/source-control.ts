import {
  chmod,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  statfs
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { writeDurableJsonFile } from "../journal/durable-json-file.js";
import {
  parseFactoryRunId,
  parseGitObjectId,
  type CandidateRelease,
  type Digest,
  type EffectInvocationContext,
  type FactoryRunId,
  type GitObjectId,
  type StageAttemptId,
  type TerminalOutcome
} from "../protocol/contracts.js";
import { validateProtocol } from "../protocol/schemas.js";
import type { CommandRequest, CommandResult, CommandRunner } from "./command-runner.js";
import type {
  PreparedSource,
  PullRequestRecord,
  SourceControlConfig,
  SourceControlPreflight,
  TerminalBranchObservation,
  TerminalCleanupPullRequestObservation,
  TerminalCleanupReceipt,
  TerminalCleanupRefObservation,
  TerminalCleanupWorktreeObservation
} from "./contracts.js";
import type { SourceControlGitHub } from "./github-boundary.js";

export { ProcessCommandRunner } from "./command-runner.js";
export type { CommandRequest, CommandResult, CommandRunner } from "./command-runner.js";
export type {
  PreparedSource,
  PullRequestRecord,
  SourceControlConfig,
  SourceControlPreflight
} from "./contracts.js";
export type { SourceControlGitHub } from "./github-boundary.js";

export interface CandidateBuildInput {
  readonly decision: "changes_ready";
  readonly stageAttemptId: StageAttemptId;
  readonly builderEvidenceDigest: Digest;
  readonly summary: string;
}

function commandError(request: CommandRequest, result: CommandResult): Error {
  return new Error(
    `${request.command} ${request.args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`
  );
}

async function runRequired(runner: CommandRunner, request: CommandRequest): Promise<string> {
  const result = await runner.run(request);
  if (result.exitCode !== 0) throw commandError(request, result);
  return result.stdout.trim();
}

function fullSha(value: string, label: string): GitObjectId {
  try {
    return parseGitObjectId(value.trim());
  } catch {
    throw new Error(`${label} must be a full Git object ID`);
  }
}

function ensureBeneath(path: string, parent: string): void {
  const relation = relative(parent, path);
  if (relation === "" || relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
    throw new Error(`path must be beneath factory state root: ${path}`);
  }
}

function parseWorktrees(output: string): readonly Readonly<{
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
}>[] {
  return output
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const fields = new Map<string, string>();
      let locked = false;
      for (const line of block.split("\n")) {
        const separator = line.indexOf(" ");
        const key = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1);
        if (key === "locked") locked = true;
        else fields.set(key, value);
      }
      return {
        path: fields.get("worktree") ?? "",
        head: fields.get("HEAD") ?? "",
        branch: fields.get("branch") ?? null,
        locked
      };
    });
}

async function findNestedGitDirectory(root: string): Promise<string | null> {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const directory = await opendir(current);
    for await (const entry of directory) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.name === ".git") {
        if (current !== root) return path;
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      pending.push(path);
    }
  }
  return null;
}

async function probeStateRoot(stateRoot: string): Promise<number> {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const probeDirectory = join(stateRoot, ".preflight");
  await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
  const from = join(probeDirectory, `rename-${process.pid}.tmp`);
  const to = join(probeDirectory, `rename-${process.pid}.ok`);
  const handle = await open(from, "w", 0o600);
  try {
    await handle.write("factory-state-preflight\n", undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(from, to);
  await rm(to, { force: true });
  const filesystem = await statfs(stateRoot);
  return Number(filesystem.bavail * filesystem.bsize);
}

function branchName(issueNumber: number, factoryRunId: FactoryRunId): string {
  return `factory/issue-${issueNumber}/${factoryRunId}`;
}

function exactStageAttempt(message: string, stageAttemptId: StageAttemptId): boolean {
  return message.split("\n").some((line) => line === `Stage-Attempt: ${stageAttemptId}`);
}

interface TerminalCleanupInput {
  readonly context: EffectInvocationContext;
  readonly issueNumber: number;
  readonly terminalOutcome: TerminalOutcome;
  readonly candidate: CandidateRelease | null;
}

type WorktreeRecord = ReturnType<typeof parseWorktrees>[number];

interface TerminalCleanupInspection {
  readonly factoryRunId: FactoryRunId;
  readonly issueNumber: number;
  readonly candidate: CandidateRelease | null;
  readonly branchName: string;
  readonly branchRef: string;
  readonly defaultBranch: string;
  readonly stateRoot: string;
  readonly worktreePath: string;
  readonly worktrees: readonly WorktreeRecord[];
  readonly atExpectedPath: readonly WorktreeRecord[];
  readonly forBranch: readonly WorktreeRecord[];
  readonly canonicalDirty: boolean | null;
  readonly localSha: GitObjectId | null;
  readonly remoteSha: GitObjectId | null;
  readonly pullRequests: readonly PullRequestRecord[];
}

type TerminalCleanupPlan =
  | Readonly<{ kind: "succeeded"; inspection: TerminalCleanupInspection; candidate: CandidateRelease }>
  | Readonly<{
      kind: "non_success";
      inspection: TerminalCleanupInspection;
      terminalOutcome: Exclude<TerminalOutcome, "succeeded">;
    }>
  | Readonly<{
      kind: "pending_cleanup";
      inspection: TerminalCleanupInspection;
      terminalOutcome: TerminalOutcome;
      reason: string;
      closeOpenPullRequest: boolean;
      failClosed: boolean;
    }>;

function refObservation(sha: GitObjectId | null): TerminalCleanupRefObservation {
  return sha === null ? { state: "absent", sha: null } : { state: "present", sha };
}

function pullRequestObservation(
  pullRequests: readonly PullRequestRecord[]
): TerminalCleanupPullRequestObservation {
  if (pullRequests.length === 0) return { state: "absent" };
  if (pullRequests.length > 1) {
    return {
      state: "ambiguous",
      entries: pullRequests.map((pullRequest) => ({
        state: pullRequest.state,
        number: pullRequest.number,
        headSha: pullRequest.headSha
      }))
    };
  }
  const pullRequest = pullRequests[0];
  if (pullRequest === undefined) return { state: "absent" };
  return { state: pullRequest.state, number: pullRequest.number, headSha: pullRequest.headSha };
}

function classifyTerminalCleanup(
  input: TerminalCleanupInput,
  inspection: TerminalCleanupInspection
): TerminalCleanupPlan {
  const pending = (
    reason: string,
    options: Readonly<{ closeOpenPullRequest?: boolean; failClosed?: boolean }> = {}
  ): TerminalCleanupPlan => ({
    kind: "pending_cleanup",
    inspection,
    terminalOutcome: input.terminalOutcome,
    reason,
    closeOpenPullRequest: options.closeOpenPullRequest ?? false,
    failClosed: options.failClosed ?? false
  });
  const pullRequest = inspection.pullRequests[0];
  const worktree = inspection.atExpectedPath[0];
  const expectedHead = input.candidate?.headCommitSha ?? inspection.localSha;

  if (
    inspection.atExpectedPath.length > 1 ||
    inspection.forBranch.length > 1 ||
    inspection.pullRequests.length > 1
  ) {
    return pending("terminal cleanup found ambiguous run assets");
  }
  if (input.terminalOutcome !== "succeeded" && pullRequest?.state === "merged") {
    return pending(
      "non-success Terminal Outcome conflicts with an already-merged pull request",
      { failClosed: true }
    );
  }
  if (inspection.forBranch[0] !== undefined && resolve(inspection.forBranch[0].path) !== inspection.worktreePath) {
    return pending("Factory Branch is registered to an unexpected worktree");
  }
  if (worktree !== undefined && worktree.branch !== inspection.branchRef) {
    return pending("canonical Factory Worktree path belongs to another branch");
  }
  if (worktree !== undefined && expectedHead === null) {
    return pending("Factory Worktree has no authoritative branch SHA");
  }
  if (worktree !== undefined && worktree.head !== expectedHead) {
    return pending("Factory Worktree HEAD differs from the authoritative run SHA");
  }
  if (input.candidate !== null && inspection.localSha !== null && inspection.localSha !== input.candidate.headCommitSha) {
    return pending("local Factory Branch differs from the terminal Candidate SHA");
  }
  if (input.candidate !== null && inspection.remoteSha !== null && inspection.remoteSha !== input.candidate.headCommitSha) {
    return pending("remote Factory Branch differs from the terminal Candidate SHA");
  }
  if (
    input.candidate === null &&
    inspection.localSha !== null &&
    inspection.remoteSha !== null &&
    inspection.localSha !== inspection.remoteSha
  ) {
    return pending("local and remote Factory Branch observations disagree");
  }
  if (
    pullRequest !== undefined &&
    (pullRequest.headBranch !== inspection.branchName ||
      pullRequest.baseBranch !== inspection.defaultBranch ||
      expectedHead === null ||
      pullRequest.headSha !== expectedHead)
  ) {
    return pending("pull request differs from the terminal Factory Branch identity");
  }
  if (input.terminalOutcome === "succeeded") {
    if (input.candidate === null) return pending("succeeded cleanup requires an exact Candidate Release");
    if (pullRequest?.state !== "merged") {
      return pending("succeeded cleanup requires the exact merged pull request");
    }
    if (inspection.canonicalDirty === true) return pending("Factory Worktree is dirty");
    return { kind: "succeeded", inspection, candidate: input.candidate };
  }
  if (inspection.canonicalDirty === true) {
    return pending("Factory Worktree is dirty", { closeOpenPullRequest: pullRequest?.state === "open" });
  }
  return {
    kind: "non_success",
    inspection,
    terminalOutcome: input.terminalOutcome
  };
}

export class GitSourceControl {
  readonly #runner: CommandRunner;
  readonly #github: SourceControlGitHub;
  readonly #config: SourceControlConfig;

  constructor(input: {
    readonly runner: CommandRunner;
    readonly github: SourceControlGitHub;
    readonly config: SourceControlConfig;
  }) {
    this.#runner = input.runner;
    this.#github = input.github;
    this.#config = input.config;
  }

  async preflight(input?: Readonly<{
    knownFactoryRunId: FactoryRunId;
    knownIssueNumber: number;
  }>): Promise<SourceControlPreflight> {
    const repositoryRoot = await realpath(this.#config.repositoryRoot);
    const topLevel = await runRequired(this.#runner, {
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: repositoryRoot
    });
    if (await realpath(topLevel) !== repositoryRoot) {
      throw new Error(`source_control_blocked_configuration: unexpected repository root ${topLevel}`);
    }
    const commonGitDirectoryRaw = await runRequired(this.#runner, {
      command: "git",
      args: ["rev-parse", "--git-common-dir"],
      cwd: repositoryRoot
    });
    const commonGitDirectory = await realpath(resolve(repositoryRoot, commonGitDirectoryRaw));

    const gitVersionOutput = await runRequired(this.#runner, { command: "git", args: ["--version"] });
    const gitVersion = gitVersionOutput.replace(/^git version /, "").trim();
    if (gitVersion !== this.#config.expectedGitVersion) {
      throw new Error(`source_control_blocked_configuration: expected Git ${this.#config.expectedGitVersion}, found ${gitVersion}`);
    }
    const ghVersionOutput = await runRequired(this.#runner, { command: "gh", args: ["--version"] });
    const gitHubCliVersion = /gh version ([0-9]+\.[0-9]+\.[0-9]+)/.exec(ghVersionOutput)?.[1] ?? "unknown";
    if (gitHubCliVersion !== this.#config.expectedGitHubCliVersion) {
      throw new Error(`source_control_blocked_configuration: expected GitHub CLI ${this.#config.expectedGitHubCliVersion}, found ${gitHubCliVersion}`);
    }

    const fetchUrl = await runRequired(this.#runner, {
      command: "git",
      args: ["remote", "get-url", this.#config.remoteName],
      cwd: repositoryRoot
    });
    const pushUrl = await runRequired(this.#runner, {
      command: "git",
      args: ["remote", "get-url", "--push", this.#config.remoteName],
      cwd: repositoryRoot
    });
    if (fetchUrl !== this.#config.expectedRemoteUrl || pushUrl !== this.#config.expectedRemoteUrl) {
      throw new Error("source_control_blocked_configuration: origin fetch/push URL mismatch");
    }
    const remoteHeadRequest = {
      command: "git",
      args: ["symbolic-ref", `refs/remotes/${this.#config.remoteName}/HEAD`],
      cwd: repositoryRoot
    } as const;
    const remoteHeadResult = await this.#runner.run(remoteHeadRequest);
    if (
      remoteHeadResult.exitCode !== 0 ||
      remoteHeadResult.stdout.trim() !== `refs/remotes/${this.#config.remoteName}/${this.#config.defaultBranch}`
    ) {
      throw new Error("source_control_blocked_configuration: remote default branch is not origin/main");
    }

    const advertised = await this.#remoteSha(`refs/heads/${this.#config.defaultBranch}`);
    if (advertised === null) throw new Error("source_control_blocked_configuration: default branch is absent");
    await runRequired(this.#runner, {
      command: "git",
      args: [
        "fetch",
        "--no-tags",
        this.#config.remoteName,
        `+refs/heads/${this.#config.defaultBranch}:refs/remotes/${this.#config.remoteName}/${this.#config.defaultBranch}`
      ],
      cwd: repositoryRoot
    });
    const fetched = fullSha(
      await runRequired(this.#runner, {
        command: "git",
        args: ["rev-parse", `refs/remotes/${this.#config.remoteName}/${this.#config.defaultBranch}`],
        cwd: repositoryRoot
      }),
      "fetched default branch"
    );
    if (fetched !== advertised) {
      throw new Error("source_control_conflict: fetched default branch does not match ls-remote");
    }

    const submodules = await runRequired(this.#runner, {
      command: "git",
      args: ["ls-files", "--stage"],
      cwd: repositoryRoot
    });
    if (submodules.split("\n").some((line) => line.startsWith("160000 "))) {
      throw new Error("source_control_blocked_capability: submodules are unsupported");
    }
    const nested = await findNestedGitDirectory(repositoryRoot);
    if (nested !== null) {
      throw new Error(`source_control_blocked_capability: nested Git repository ${nested}`);
    }

    if (input !== undefined) {
      const plannedBranchRef = `refs/heads/${branchName(input.knownIssueNumber, input.knownFactoryRunId)}`;
      const plannedWorktreePath = resolve(
        await realpath(this.#config.stateRoot),
        "runs",
        input.knownFactoryRunId,
        "worktree"
      );
      const worktrees = parseWorktrees(
        await runRequired(this.#runner, {
          command: "git",
          args: ["worktree", "list", "--porcelain"],
          cwd: repositoryRoot
        })
      );
      const branchWorktrees = worktrees.filter((worktree) => worktree.branch === plannedBranchRef);
      if (
        branchWorktrees.length > 1 ||
        (branchWorktrees[0] !== undefined && resolve(branchWorktrees[0].path) !== plannedWorktreePath)
      ) {
        throw new Error("source_control_conflict: planned Factory Branch is registered to another worktree");
      }
    }
    const worktrees = parseWorktrees(
      await runRequired(this.#runner, {
        command: "git",
        args: ["worktree", "list", "--porcelain"],
        cwd: repositoryRoot
      })
    );

    const primaryStatus = await runRequired(this.#runner, {
      command: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: repositoryRoot
    });
    const stateRootAvailableBytes = await probeStateRoot(this.#config.stateRoot);
    const stateRoot = await realpath(this.#config.stateRoot);
    for (const worktree of worktrees) {
      const relation = relative(resolve(worktree.path), stateRoot);
      if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
        throw new Error("source_control_blocked_configuration: factory state root is inside a checkout");
      }
    }
    if (stateRootAvailableBytes < 64 * 1024 * 1024) {
      throw new Error("source_control_blocked_capability: factory state root has insufficient free space");
    }
    const readConfig = async (key: string): Promise<string | null> => {
      const request = { command: "git", args: ["config", "--get", key], cwd: repositoryRoot } as const;
      const result = await this.#runner.run(request);
      if (result.exitCode === 1) return null;
      if (result.exitCode !== 0) throw commandError(request, result);
      return result.stdout.trim();
    };
    const gitConfig = {
      objectFormat: (await readConfig("extensions.objectFormat")) ?? "sha1",
      hooksPath: await readConfig("core.hooksPath"),
      commitGpgSign: await readConfig("commit.gpgSign")
    };
    return {
      repositoryRoot,
      commonGitDirectory,
      remoteUrl: fetchUrl,
      defaultBranchSha: advertised,
      gitVersion,
      gitHubCliVersion,
      branchMode: this.#config.branchMode,
      branchModeEvidence: this.#config.branchModeEvidence,
      primaryCheckoutDirty: primaryStatus !== "",
      stateRootAvailableBytes,
      gitConfig
    };
  }

  async prepareRun(input: {
    readonly context: EffectInvocationContext;
    readonly issueNumber: number;
    readonly baseSha: GitObjectId;
  }): Promise<PreparedSource> {
    const factoryRunId = parseFactoryRunId(input.context.factoryRunId);
    const name = branchName(input.issueNumber, factoryRunId);
    const branchRef = `refs/heads/${name}`;
    await mkdir(this.#config.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(this.#config.stateRoot);
    const worktreePath = resolve(stateRoot, "runs", factoryRunId, "worktree");
    ensureBeneath(worktreePath, stateRoot);
    await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });

    let remoteSha = await this.#remoteSha(branchRef);
    const localSha = await this.#localRefSha(branchRef);
    if (remoteSha !== null && remoteSha !== input.baseSha) {
      throw new Error(`source_control_conflict: remote Factory Branch ${name} has unexpected SHA`);
    }
    if (localSha !== null && localSha !== input.baseSha) {
      throw new Error(`source_control_conflict: local Factory Branch ${name} has unexpected SHA`);
    }

    if (this.#config.branchMode === "linked") {
      const linked = await this.#github.listLinkedBranches(input.issueNumber);
      if (!linked.includes(name)) {
        if (remoteSha !== null) {
          throw new Error("source_control_conflict: branch exists remotely without the required issue link");
        }
        await this.#github.createLinkedBranch({
          issueNumber: input.issueNumber,
          branch: name,
          baseBranch: this.#config.defaultBranch
        });
      }
      const verifiedLinks = await this.#github.listLinkedBranches(input.issueNumber);
      if (verifiedLinks.filter((branch) => branch === name).length !== 1) {
        throw new Error("source_control_conflict: linked Factory Branch did not reconcile exactly once");
      }
      remoteSha = await this.#remoteSha(branchRef);
      if (remoteSha !== input.baseSha) {
        throw new Error("source_control_conflict: linked Factory Branch base SHA mismatch");
      }
    }

    if (await this.#localRefSha(branchRef) === null) {
      if (remoteSha !== null) {
        await runRequired(this.#runner, {
          command: "git",
          args: ["fetch", "--no-tags", this.#config.remoteName, `+${branchRef}:refs/remotes/${this.#config.remoteName}/${name}`],
          cwd: this.#config.repositoryRoot
        });
        await runRequired(this.#runner, {
          command: "git",
          args: ["branch", "--track", name, `refs/remotes/${this.#config.remoteName}/${name}`],
          cwd: this.#config.repositoryRoot
        });
      } else {
        await runRequired(this.#runner, {
          command: "git",
          args: ["branch", name, input.baseSha],
          cwd: this.#config.repositoryRoot
        });
      }
    }

    const worktreesBefore = await this.#worktrees();
    const existingAtPath = worktreesBefore.find((worktree) => resolve(worktree.path) === worktreePath);
    const existingForBranch = worktreesBefore.find((worktree) => worktree.branch === branchRef);
    if (existingForBranch !== undefined && resolve(existingForBranch.path) !== worktreePath) {
      throw new Error("source_control_conflict: Factory Branch is registered to another worktree");
    }
    if (existingAtPath === undefined) {
      await runRequired(this.#runner, {
        command: "git",
        args: ["worktree", "add", worktreePath, name],
        cwd: this.#config.repositoryRoot
      });
    } else if (existingAtPath.branch !== branchRef || existingAtPath.head !== input.baseSha) {
      throw new Error("source_control_conflict: Factory Worktree identity mismatch");
    }

    const verifiedWorktree = (await this.#worktrees()).find((worktree) => resolve(worktree.path) === worktreePath);
    if (verifiedWorktree === undefined || verifiedWorktree.branch !== branchRef || verifiedWorktree.head !== input.baseSha) {
      throw new Error("source_control_conflict: Factory Worktree verification failed");
    }
    if (!verifiedWorktree.locked) {
      await runRequired(this.#runner, {
        command: "git",
        args: ["worktree", "lock", "--reason", factoryRunId, worktreePath],
        cwd: this.#config.repositoryRoot
      });
    }

    remoteSha = await this.#remoteSha(branchRef);
    if (remoteSha === null) {
      await runRequired(this.#runner, {
        command: "git",
        args: ["push", "--set-upstream", this.#config.remoteName, `${branchRef}:${branchRef}`],
        cwd: this.#config.repositoryRoot
      });
      remoteSha = await this.#remoteSha(branchRef);
    }
    if (remoteSha !== input.baseSha) {
      throw new Error("source_control_conflict: pushed Factory Branch base SHA mismatch");
    }
    const fetchedBranchSha = await this.#fetchRemoteBranch(name);
    if (fetchedBranchSha !== input.baseSha) {
      throw new Error("source_control_conflict: fetched Factory Branch base SHA mismatch");
    }

    return {
      factoryRunId,
      branchName: name,
      branchRef,
      worktreePath,
      baseSha: input.baseSha,
      branchMode: this.#config.branchMode
    };
  }

  async createCandidate(input: {
    readonly context: EffectInvocationContext;
    readonly prepared: PreparedSource;
    readonly issueNumber: number;
    readonly candidateOrdinal: number;
    readonly previousCandidateHeadSha: GitObjectId | null;
    readonly build: CandidateBuildInput;
  }): Promise<CandidateRelease> {
    if (input.context.factoryRunId !== input.prepared.factoryRunId) {
      throw new Error("source_control_conflict: Candidate context belongs to another Factory Run");
    }
    const messageBefore = await this.#git(input.prepared.worktreePath, "log", "-1", "--format=%B");
    const alreadyCommitted = exactStageAttempt(messageBefore, input.build.stageAttemptId);
    if (!alreadyCommitted) {
      const status = await this.#git(input.prepared.worktreePath, "status", "--porcelain=v1", "--untracked-files=all");
      if (status === "") throw new Error("source_control_conflict: successful Builder attempt produced no changes");
      await this.#git(input.prepared.worktreePath, "add", "-A", "--", ".");
      await this.#git(input.prepared.worktreePath, "diff", "--cached", "--check");
      const hooksDirectory = resolve(this.#config.stateRoot, "hooks-empty");
      await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
      const subject = `factory: issue #${input.issueNumber} build attempt ${input.candidateOrdinal}`;
      const body = [
        `Factory-Run: ${input.prepared.factoryRunId}`,
        `Stage-Attempt: ${input.build.stageAttemptId}`,
        `GitHub-Issue: #${input.issueNumber}`,
        `Candidate-Ordinal: ${input.candidateOrdinal}`
      ].join("\n");
      await this.#git(
        input.prepared.worktreePath,
        "-c",
        `core.hooksPath=${hooksDirectory}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Agentic Software Factory",
        "-c",
        "user.email=agentic-software-factory@localhost",
        "commit",
        "-m",
        subject,
        "-m",
        body
      );
    } else {
      const status = await this.#git(input.prepared.worktreePath, "status", "--porcelain=v1", "--untracked-files=all");
      if (status !== "") {
        throw new Error("source_control_conflict: reconciled Candidate commit has a dirty worktree");
      }
    }

    const headSha = fullSha(await this.#git(input.prepared.worktreePath, "rev-parse", "HEAD"), "Candidate HEAD");
    const message = await this.#git(input.prepared.worktreePath, "log", "-1", "--format=%B");
    if (!exactStageAttempt(message, input.build.stageAttemptId)) {
      throw new Error("source_control_conflict: Candidate HEAD belongs to another Stage Attempt");
    }
    const expectedParent = input.previousCandidateHeadSha ?? input.prepared.baseSha;
    if ((input.candidateOrdinal === 1) !== (input.previousCandidateHeadSha === null)) {
      throw new Error("source_control_conflict: Candidate ordinal and previous Candidate identity disagree");
    }
    const parentSha = fullSha(await this.#git(input.prepared.worktreePath, "rev-parse", "HEAD^"), "Candidate parent");
    if (parentSha !== expectedParent) {
      throw new Error("source_control_conflict: Candidate commit parent mismatch");
    }
    const treeSha = fullSha(await this.#git(input.prepared.worktreePath, "rev-parse", "HEAD^{tree}"), "Candidate tree");
    const clean = await this.#git(input.prepared.worktreePath, "status", "--porcelain=v1", "--untracked-files=all");
    if (clean !== "") throw new Error("source_control_conflict: Candidate worktree is not clean");

    let remoteSha = await this.#remoteSha(input.prepared.branchRef);
    if (remoteSha !== headSha) {
      if (remoteSha !== expectedParent) {
        throw new Error("source_control_conflict: remote Factory Branch is not the expected fast-forward parent");
      }
      await this.#git(
        input.prepared.worktreePath,
        "push",
        this.#config.remoteName,
        `${input.prepared.branchRef}:${input.prepared.branchRef}`
      );
      remoteSha = await this.#remoteSha(input.prepared.branchRef);
    }
    if (remoteSha !== headSha) {
      throw new Error("source_control_conflict: remote Factory Branch did not reach Candidate HEAD");
    }
    const fetchedCandidateSha = await this.#fetchRemoteBranch(input.prepared.branchName);
    if (fetchedCandidateSha !== headSha) {
      throw new Error("source_control_conflict: fetched Factory Branch did not match Candidate HEAD");
    }
    const ancestryRequest = {
      command: "git",
      args: ["merge-base", "--is-ancestor", input.prepared.baseSha, headSha],
      cwd: input.prepared.worktreePath
    } as const;
    const ancestry = await this.#runner.run(ancestryRequest);
    if (ancestry.exitCode !== 0) {
      throw new Error("source_control_conflict: Candidate no longer descends from the immutable base SHA");
    }
    const mergeCommits = await this.#git(
      input.prepared.worktreePath,
      "rev-list",
      "--merges",
      `${input.prepared.baseSha}..${headSha}`
    );
    if (mergeCommits !== "") {
      throw new Error("source_control_conflict: Factory Branch history is not linear");
    }

    let pullRequests = await this.#github.listPullRequests(input.prepared.branchName);
    if (pullRequests.length > 1) {
      throw new Error("source_control_conflict: multiple pull requests exist for Factory Branch");
    }
    if (pullRequests[0] === undefined) {
      await this.#github.createDraftPullRequest({
        issueNumber: input.issueNumber,
        headBranch: input.prepared.branchName,
        baseBranch: this.#config.defaultBranch,
        headSha,
        title: `Factory Run ${input.prepared.factoryRunId}: issue #${input.issueNumber}`,
        body: [
          `Factory Run: \`${input.prepared.factoryRunId}\``,
          `Base SHA: \`${input.prepared.baseSha}\``,
          `Factory Branch: \`${input.prepared.branchName}\``,
          `Candidate SHA: \`${headSha}\``,
          `Refs #${input.issueNumber}`
        ].join("\n\n")
      });
      pullRequests = await this.#github.listPullRequests(input.prepared.branchName);
    }
    const pullRequest = pullRequests[0];
    if (
      pullRequests.length !== 1 ||
      pullRequest === undefined ||
      pullRequest.state !== "open" ||
      pullRequest.headBranch !== input.prepared.branchName ||
      pullRequest.headSha !== headSha ||
      pullRequest.baseBranch !== this.#config.defaultBranch
    ) {
      throw new Error("source_control_conflict: pull request does not bind the exact Candidate SHA");
    }

    return {
      schemaVersion: "1.0",
      contract: "candidate_release",
      factoryRunId: input.prepared.factoryRunId,
      candidateOrdinal: input.candidateOrdinal,
      builderStageAttemptId: input.build.stageAttemptId,
      branchRef: input.prepared.branchRef,
      baseSha: input.prepared.baseSha,
      headCommitSha: headSha,
      sourceTreeSha: treeSha
    };
  }

  async readyCandidate(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
  }): Promise<PullRequestRecord> {
    const number = await this.#pullRequestNumberFor(input.candidate.branchRef);
    const pullRequest = await this.#github.getPullRequest(number);
    if (
      pullRequest.state !== "open" ||
      pullRequest.headSha !== input.candidate.headCommitSha ||
      pullRequest.baseBranch !== this.#config.defaultBranch
    ) {
      throw new Error("source_control_conflict: pull request is not bound to the exact Candidate before readying");
    }
    const ready = await this.#github.markPullRequestReady(number);
    if (ready.isDraft || ready.headSha !== input.candidate.headCommitSha) {
      throw new Error("source_control_conflict: ready pull request is stale or still draft");
    }
    return ready;
  }

  async readPullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: GitObjectId;
  }): Promise<PullRequestRecord> {
    const expected = fullSha(input.expectedHeadSha, "expected pull-request head");
    const pullRequest = await this.#github.getPullRequest(input.number);
    if (pullRequest.headSha !== expected) {
      throw new Error("source_control_conflict: pull request head is not the exact Candidate SHA");
    }
    return pullRequest;
  }

  async integrateCandidate(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
    readonly pullRequestNumber?: number;
  }): Promise<Readonly<{ integrationCommitSha: GitObjectId; sourceTreeSha: GitObjectId }>> {
    const pullRequestNumber = input.pullRequestNumber ?? await this.#pullRequestNumberFor(input.candidate.branchRef);
    const before = await this.#github.getPullRequest(pullRequestNumber);
    if (
      before.headSha !== input.candidate.headCommitSha ||
      before.baseBranch !== this.#config.defaultBranch ||
      before.isDraft
    ) {
      throw new Error("source_control_conflict: merge intent does not match a ready pull request identity");
    }
    let merged = before;
    if (before.state !== "merged") {
      if (before.state !== "open") throw new Error("source_control_conflict: pull request is not open");
      if (!await this.#github.requiredChecksPass({
        number: pullRequestNumber,
        expectedHeadSha: input.candidate.headCommitSha
      })) {
        throw new Error("source_control_conflict: required checks have not passed for the exact Candidate SHA");
      }
      const checkedPullRequest = await this.#github.getPullRequest(pullRequestNumber);
      if (
        checkedPullRequest.state !== "open" ||
        checkedPullRequest.headSha !== input.candidate.headCommitSha ||
        checkedPullRequest.baseBranch !== this.#config.defaultBranch
      ) {
        throw new Error("source_control_conflict: pull request identity changed while reading required checks");
      }
      const currentBase = await this.#remoteSha(`refs/heads/${this.#config.defaultBranch}`);
      if (currentBase !== input.candidate.baseSha) {
        throw new Error("source_control_conflict: default branch drifted before integration");
      }
      merged = await this.#github.mergePullRequest({
        number: pullRequestNumber,
        expectedHeadSha: input.candidate.headCommitSha
      });
    }
    if (merged.state !== "merged" || merged.mergeCommitSha === null) {
      throw new Error("source_control_conflict: pull request merge was not verified");
    }
    const integrationSha = fullSha(merged.mergeCommitSha, "Integration Commit");
    await this.#git(
      this.#config.repositoryRoot,
      "fetch",
      "--no-tags",
      this.#config.remoteName,
      `+refs/heads/${this.#config.defaultBranch}:refs/remotes/${this.#config.remoteName}/${this.#config.defaultBranch}`
    );
    const defaultTip = fullSha(
      await this.#git(this.#config.repositoryRoot, "rev-parse", `refs/remotes/${this.#config.remoteName}/${this.#config.defaultBranch}`),
      "default branch tip"
    );
    if (defaultTip !== integrationSha) {
      throw new Error("source_control_conflict: default branch tip is not the Integration Commit");
    }
    const treeSha = fullSha(
      await this.#git(this.#config.repositoryRoot, "rev-parse", `${integrationSha}^{tree}`),
      "Integration Commit tree"
    );
    if (treeSha !== input.candidate.sourceTreeSha) {
      throw new Error("source_control_conflict: Integration Commit tree differs from Candidate tree");
    }
    return { integrationCommitSha: integrationSha, sourceTreeSha: treeSha };
  }

  async observeTerminalBranch(input: {
    readonly context: EffectInvocationContext;
    readonly issueNumber: number;
  }): Promise<TerminalBranchObservation> {
    const factoryRunId = parseFactoryRunId(input.context.factoryRunId);
    const branchRef = `refs/heads/${branchName(input.issueNumber, factoryRunId)}`;
    const remoteSha = await this.#remoteSha(branchRef);
    return remoteSha === null
      ? { state: "absent" }
      : { state: "present", branchRef, remoteSha };
  }

  async cleanupTerminal(input: TerminalCleanupInput): Promise<TerminalCleanupReceipt> {
    const factoryRunId = parseFactoryRunId(input.context.factoryRunId);
    if (input.candidate !== null && input.candidate.factoryRunId !== factoryRunId) {
      throw new Error("source_control_conflict: terminal cleanup Candidate belongs to another Factory Run");
    }
    const expectedBranchRef = `refs/heads/${branchName(input.issueNumber, factoryRunId)}`;
    if (input.candidate !== null && input.candidate.branchRef !== expectedBranchRef) {
      throw new Error("source_control_conflict: terminal cleanup Candidate branch identity mismatch");
    }

    const inspection = await this.#inspectTerminalCleanup(
      factoryRunId,
      input.issueNumber,
      input.candidate
    );
    const plan = classifyTerminalCleanup(input, inspection);
    switch (plan.kind) {
      case "succeeded":
        return this.#executeSucceededCleanup(plan);
      case "non_success":
        return this.#executeNonSuccessCleanup(plan);
      case "pending_cleanup":
        return this.#executePendingCleanup(plan);
    }
  }

  async #inspectTerminalCleanup(
    factoryRunId: FactoryRunId,
    issueNumber: number,
    candidate: CandidateRelease | null
  ): Promise<TerminalCleanupInspection> {
    const name = branchName(issueNumber, factoryRunId);
    const branchRef = `refs/heads/${name}`;
    const stateRoot = await realpath(this.#config.stateRoot);
    const worktreePath = resolve(stateRoot, "runs", factoryRunId, "worktree");
    ensureBeneath(worktreePath, stateRoot);
    const worktrees = await this.#worktrees();
    const atExpectedPath = worktrees.filter((worktree) => resolve(worktree.path) === worktreePath);
    const forBranch = worktrees.filter((worktree) => worktree.branch === branchRef);
    let canonicalDirty: boolean | null = null;
    if (atExpectedPath.length === 1 && atExpectedPath[0]?.branch === branchRef) {
      const request = {
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: worktreePath
      } as const;
      const status = await this.#runner.run(request);
      if (status.exitCode !== 0) throw commandError(request, status);
      canonicalDirty = status.stdout.trim() !== "";
    }
    return {
      factoryRunId,
      issueNumber,
      candidate,
      branchName: name,
      branchRef,
      defaultBranch: this.#config.defaultBranch,
      stateRoot,
      worktreePath,
      worktrees,
      atExpectedPath,
      forBranch,
      canonicalDirty,
      localSha: await this.#localRefSha(branchRef),
      remoteSha: await this.#remoteSha(branchRef),
      pullRequests: await this.#github.listPullRequests(name)
    };
  }

  async #executePendingCleanup(
    plan: Extract<TerminalCleanupPlan, { kind: "pending_cleanup" }>
  ): Promise<TerminalCleanupReceipt> {
    const initialPullRequest = plan.inspection.pullRequests[0];
    if (plan.closeOpenPullRequest && initialPullRequest?.state === "open") {
      const closed = await this.#github.closePullRequest(initialPullRequest.number);
      if (
        closed.state !== "closed" ||
        closed.headBranch !== plan.inspection.branchName ||
        closed.baseBranch !== this.#config.defaultBranch ||
        closed.headSha !== initialPullRequest.headSha
      ) {
        throw new Error("source_control_conflict: terminal pull-request close did not verify");
      }
    }
    for (const worktree of plan.inspection.forBranch) {
      if (!worktree.locked) {
        await this.#git(
          this.#config.repositoryRoot,
          "worktree",
          "lock",
          "--reason",
          `terminal-pending-cleanup:${plan.inspection.factoryRunId}`,
          worktree.path
        );
      }
    }
    const finalInspection = await this.#inspectTerminalCleanup(
      plan.inspection.factoryRunId,
      plan.inspection.issueNumber,
      plan.inspection.candidate
    );
    const receipt: TerminalCleanupReceipt = {
      schemaVersion: "1.0",
      contract: "terminal_cleanup_receipt",
      status: "pending_cleanup",
      terminalOutcome: plan.terminalOutcome,
      worktree: this.#pendingWorktreeObservation(finalInspection),
      localBranch: refObservation(finalInspection.localSha),
      remoteBranch: refObservation(finalInspection.remoteSha),
      pullRequest: pullRequestObservation(finalInspection.pullRequests),
      reason: plan.reason
    };
    await this.#persistTerminalCleanupReceipt(finalInspection, receipt);
    if (plan.failClosed) throw new Error(`source_control_conflict: ${plan.reason}`);
    return receipt;
  }

  async #executeSucceededCleanup(
    plan: Extract<TerminalCleanupPlan, { kind: "succeeded" }>
  ): Promise<TerminalCleanupReceipt> {
    await this.#removeTerminalWorktree(plan.inspection);
    if (plan.inspection.localSha !== null) {
      await this.#git(
        this.#config.repositoryRoot,
        "update-ref",
        "-d",
        plan.inspection.branchRef,
        plan.candidate.headCommitSha
      );
    }
    if (plan.inspection.remoteSha !== null) {
      await this.#git(
        this.#config.repositoryRoot,
        "push",
        `--force-with-lease=${plan.inspection.branchRef}:${plan.candidate.headCommitSha}`,
        this.#config.remoteName,
        `:${plan.inspection.branchRef}`
      );
    }
    const finalInspection = await this.#inspectTerminalCleanup(
      plan.inspection.factoryRunId,
      plan.inspection.issueNumber,
      plan.candidate
    );
    const finalPullRequest = finalInspection.pullRequests[0];
    if (
      finalInspection.atExpectedPath.length !== 0 ||
      finalInspection.forBranch.length !== 0 ||
      finalInspection.localSha !== null ||
      finalInspection.remoteSha !== null ||
      finalInspection.pullRequests.length !== 1 ||
      finalPullRequest?.state !== "merged" ||
      finalPullRequest.headSha !== plan.candidate.headCommitSha
    ) {
      throw new Error("source_control_conflict: succeeded terminal cleanup did not verify exact final state");
    }
    const receipt: TerminalCleanupReceipt = {
      schemaVersion: "1.0",
      contract: "terminal_cleanup_receipt",
      status: "complete",
      terminalOutcome: "succeeded",
      worktree: { state: "absent" },
      localBranch: { state: "absent", sha: null },
      remoteBranch: { state: "absent", sha: null },
      pullRequest: {
        state: "merged",
        number: finalPullRequest.number,
        headSha: finalPullRequest.headSha
      }
    };
    await this.#persistTerminalCleanupReceipt(finalInspection, receipt);
    return receipt;
  }

  async #executeNonSuccessCleanup(
    plan: Extract<TerminalCleanupPlan, { kind: "non_success" }>
  ): Promise<TerminalCleanupReceipt> {
    const pullRequest = plan.inspection.pullRequests[0];
    if (pullRequest?.state === "open") {
      const closed = await this.#github.closePullRequest(pullRequest.number);
      if (
        closed.state !== "closed" ||
        closed.headBranch !== plan.inspection.branchName ||
        closed.baseBranch !== this.#config.defaultBranch ||
        closed.headSha !== pullRequest.headSha
      ) {
        throw new Error("source_control_conflict: terminal pull-request close did not verify");
      }
    }
    await this.#removeTerminalWorktree(plan.inspection);
    const finalInspection = await this.#inspectTerminalCleanup(
      plan.inspection.factoryRunId,
      plan.inspection.issueNumber,
      plan.inspection.candidate
    );
    const finalPullRequest = finalInspection.pullRequests[0];
    if (
      finalInspection.atExpectedPath.length !== 0 ||
      finalInspection.forBranch.length !== 0 ||
      finalInspection.pullRequests.length > 1 ||
      finalPullRequest?.state === "open" ||
      finalPullRequest?.state === "merged"
    ) {
      const reason = finalPullRequest?.state === "merged"
        ? "non-success Terminal Outcome conflicts with an already-merged pull request"
        : "non-success terminal cleanup did not verify exact final state";
      return this.#executePendingCleanup({
        kind: "pending_cleanup",
        inspection: finalInspection,
        terminalOutcome: plan.terminalOutcome,
        reason,
        closeOpenPullRequest: false,
        failClosed: finalPullRequest?.state === "merged"
      });
    }
    const receipt: TerminalCleanupReceipt = {
      schemaVersion: "1.0",
      contract: "terminal_cleanup_receipt",
      status: "complete",
      terminalOutcome: plan.terminalOutcome,
      worktree: { state: "absent" },
      localBranch: refObservation(finalInspection.localSha),
      remoteBranch: refObservation(finalInspection.remoteSha),
      pullRequest: finalPullRequest === undefined
        ? { state: "absent" }
        : { state: "closed", number: finalPullRequest.number, headSha: finalPullRequest.headSha }
    };
    await this.#persistTerminalCleanupReceipt(finalInspection, receipt);
    return receipt;
  }

  async #removeTerminalWorktree(inspection: TerminalCleanupInspection): Promise<void> {
    const worktree = inspection.atExpectedPath[0];
    if (worktree === undefined) return;
    if (worktree.locked) {
      await this.#git(this.#config.repositoryRoot, "worktree", "unlock", inspection.worktreePath);
    }
    const request = {
      command: "git",
      args: ["worktree", "remove", inspection.worktreePath],
      cwd: this.#config.repositoryRoot
    } as const;
    const removed = await this.#runner.run(request);
    if (removed.exitCode !== 0) {
      const remaining = (await this.#worktrees()).find(
        (candidate) => resolve(candidate.path) === inspection.worktreePath
      );
      if (remaining !== undefined && !remaining.locked) {
        await this.#git(
          this.#config.repositoryRoot,
          "worktree",
          "lock",
          "--reason",
          `terminal-pending-cleanup:${inspection.factoryRunId}`,
          inspection.worktreePath
        );
      }
      throw commandError(request, removed);
    }
    if ((await this.#worktrees()).some((candidate) => resolve(candidate.path) === inspection.worktreePath)) {
      throw new Error("source_control_conflict: Factory Worktree remained registered after cleanup");
    }
  }

  #pendingWorktreeObservation(
    inspection: TerminalCleanupInspection
  ): TerminalCleanupWorktreeObservation {
    const byPath = new Map<string, WorktreeRecord>();
    for (const worktree of [...inspection.forBranch, ...inspection.atExpectedPath]) {
      byPath.set(resolve(worktree.path), worktree);
    }
    const relevant = [...byPath.values()];
    const exact = relevant[0];
    if (relevant.length === 0) return { state: "absent" };
    if (
      relevant.length === 1 &&
      exact !== undefined &&
      exact.branch === inspection.branchRef &&
      exact.locked
    ) {
      return {
        state: "locked",
        path: exact.path,
        branchRef: inspection.branchRef,
        headSha: fullSha(exact.head, "pending-cleanup worktree HEAD"),
        dirty: resolve(exact.path) === inspection.worktreePath ? inspection.canonicalDirty : null
      };
    }
    return {
      state: "ambiguous",
      entries: relevant.map((worktree) => ({
        path: worktree.path,
        branchRef: worktree.branch,
        headSha: fullSha(worktree.head, "ambiguous worktree HEAD"),
        locked: worktree.locked
      }))
    };
  }

  async #persistTerminalCleanupReceipt(
    inspection: TerminalCleanupInspection,
    receipt: TerminalCleanupReceipt
  ): Promise<void> {
    const validation = validateProtocol<TerminalCleanupReceipt>("terminal-cleanup-receipt", receipt);
    if (!validation.ok) {
      throw new Error(`terminal cleanup receipt contract violation: ${validation.errors.join("; ")}`);
    }
    await writeDurableJsonFile(
      join(inspection.stateRoot, "runs", inspection.factoryRunId, "terminal-cleanup.json"),
      receipt
    );
  }

  async #pullRequestNumberFor(branchRef: string): Promise<number> {
    const prefix = "refs/heads/";
    if (!branchRef.startsWith(prefix)) {
      throw new Error("source_control_conflict: Candidate branch ref is not a local head ref");
    }
    const pullRequests = await this.#github.listPullRequests(branchRef.slice(prefix.length));
    if (pullRequests.length !== 1 || pullRequests[0] === undefined) {
      throw new Error("source_control_conflict: exact Factory Branch pull request is missing or ambiguous");
    }
    return pullRequests[0].number;
  }

  async #git(cwd: string, ...args: string[]): Promise<string> {
    return runRequired(this.#runner, { command: "git", args, cwd });
  }

  async #fetchRemoteBranch(name: string): Promise<GitObjectId> {
    const branchRef = `refs/heads/${name}`;
    const trackingRef = `refs/remotes/${this.#config.remoteName}/${name}`;
    await this.#git(
      this.#config.repositoryRoot,
      "fetch",
      "--no-tags",
      this.#config.remoteName,
      `+${branchRef}:${trackingRef}`
    );
    return fullSha(
      await this.#git(this.#config.repositoryRoot, "rev-parse", trackingRef),
      `fetched remote branch ${name}`
    );
  }

  async #localRefSha(ref: string): Promise<GitObjectId | null> {
    const request = { command: "git", args: ["rev-parse", "--verify", "--quiet", ref], cwd: this.#config.repositoryRoot } as const;
    const result = await this.#runner.run(request);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw commandError(request, result);
    return fullSha(result.stdout, `local ref ${ref}`);
  }

  async #remoteSha(ref: string): Promise<GitObjectId | null> {
    const request = {
      command: "git",
      args: ["ls-remote", this.#config.remoteName, ref],
      cwd: this.#config.repositoryRoot
    } as const;
    const result = await this.#runner.run(request);
    if (result.exitCode !== 0) throw commandError(request, result);
    const line = result.stdout.trim();
    if (line === "") return null;
    const sha = line.split(/\s+/, 1)[0];
    if (sha === undefined) return null;
    return fullSha(sha, `remote ref ${ref}`);
  }

  async #worktrees(): Promise<ReturnType<typeof parseWorktrees>> {
    return parseWorktrees(await this.#git(this.#config.repositoryRoot, "worktree", "list", "--porcelain"));
  }
}
