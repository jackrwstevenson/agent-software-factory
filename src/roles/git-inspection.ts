import { createHash } from "node:crypto";
import { lstat, opendir, readFile, readlink, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { canonicalSha256 } from "../protocol/canonical-json.js";
import type { Digest } from "../protocol/contracts.js";
import type { FactoryRole, RolePostconditions } from "./contracts.js";
import { RoleRuntimeError } from "./errors.js";

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<CommandOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1
      });
    });
  });
}

async function requiredGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<string> {
  const result = await runGit(cwd, args, environment);
  if (result.exitCode !== 0) {
    throw new RoleRuntimeError(
      "worker_protocol_error",
      `git ${args.join(" ")} failed: ${result.stderr.trim()}`
    );
  }
  return result.stdout;
}

async function snapshotFiles(root: string): Promise<Digest> {
  const entries: Array<Readonly<{
    path: string;
    kind: "file" | "symlink";
    mode: number;
    sha256: string;
  }>> = [];

  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    const children = [];
    for await (const child of handle) children.push(child);
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (directory === root && child.name === ".git") continue;
      const absolute = join(directory, child.name);
      const logical = relative(root, absolute).split(sep).join("/");
      const status = await lstat(absolute);
      if (status.isDirectory()) {
        await visit(absolute);
      } else if (status.isSymbolicLink()) {
        const target = await readlink(absolute);
        entries.push({
          path: logical,
          kind: "symlink",
          mode: status.mode & 0o777,
          sha256: createHash("sha256").update(target).digest("hex")
        });
      } else if (status.isFile()) {
        entries.push({
          path: logical,
          kind: "file",
          mode: status.mode & 0o777,
          sha256: createHash("sha256").update(await readFile(absolute)).digest("hex")
        });
      }
    }
  }

  await visit(root);
  return canonicalSha256(entries);
}

export interface RepositorySnapshot {
  readonly headSha: string;
  readonly sourceTreeSha: string;
  readonly symbolicRef: string;
  readonly refsDigest: Digest;
  readonly indexDigest: Digest;
  readonly statusDigest: Digest;
  readonly filesDigest: Digest;
}

export async function inspectRepository(
  worktreePath: string,
  environment: NodeJS.ProcessEnv
): Promise<RepositorySnapshot> {
  const [headSha, sourceTreeSha, symbolicRef, refs, index, status, filesDigest] = await Promise.all([
    requiredGit(worktreePath, ["rev-parse", "HEAD"], environment),
    requiredGit(worktreePath, ["rev-parse", "HEAD^{tree}"], environment),
    requiredGit(worktreePath, ["symbolic-ref", "-q", "HEAD"], environment),
    requiredGit(worktreePath, ["for-each-ref", "--format=%(refname)%00%(objectname)"], environment),
    requiredGit(worktreePath, ["ls-files", "--stage", "-z"], environment),
    requiredGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], environment),
    snapshotFiles(worktreePath)
  ]);
  return {
    headSha: headSha.trim(),
    sourceTreeSha: sourceTreeSha.trim(),
    symbolicRef: symbolicRef.trim(),
    refsDigest: canonicalSha256(refs),
    indexDigest: canonicalSha256(index),
    statusDigest: canonicalSha256(status),
    filesDigest
  };
}



export async function candidateDiffFacts(input: Readonly<{
  worktreePath: string;
  baseSha: string;
  headSha: string;
  environment: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ changedPaths: readonly string[]; diffSha256: Digest }>> {
  const [names, diff] = await Promise.all([
    requiredGit(input.worktreePath, ["diff", "--name-only", "-z", `${input.baseSha}..${input.headSha}`, "--"], input.environment),
    requiredGit(input.worktreePath, ["diff", "--binary", "--no-ext-diff", `${input.baseSha}..${input.headSha}`, "--"], input.environment)
  ]);
  return {
    changedPaths: names.split("\0").filter(Boolean).sort(),
    diffSha256: canonicalSha256({ algorithm: "git-diff-binary-v1", bytes_sha256: createHash("sha256").update(diff, "utf8").digest("hex") })
  };
}

export async function assertCanonicalRoleCheckout(input: Readonly<{
  role: FactoryRole;
  worktreePath: string;
  stateRoot: string;
  factoryRunId: string;
  branchRef: string;
  baseSha: string;
  candidate: Readonly<{ factoryRunId: string; headCommitSha: string; sourceTreeSha: string; branchRef: string }> | null;
  environment: NodeJS.ProcessEnv;
}>): Promise<RepositorySnapshot> {
  const expectedPath = resolve(input.stateRoot, "runs", input.factoryRunId, "worktree");
  let canonicalPath: string;
  let expectedCanonical: string;
  try {
    [canonicalPath, expectedCanonical] = await Promise.all([
      realpath(input.worktreePath),
      realpath(expectedPath)
    ]);
  } catch {
    throw new RoleRuntimeError("candidate_mismatch", "role checkout is not the canonical run-bound worktree");
  }
  const requestedStatus = await lstat(input.worktreePath);
  if (
    requestedStatus.isSymbolicLink() ||
    canonicalPath !== expectedCanonical
  ) {
    throw new RoleRuntimeError("candidate_mismatch", "role checkout is noncanonical or belongs to another Factory Run");
  }

  const topLevel = (await requiredGit(canonicalPath, ["rev-parse", "--show-toplevel"], input.environment)).trim();
  if (await realpath(topLevel) !== canonicalPath) {
    throw new RoleRuntimeError("candidate_mismatch", "role checkout is not the repository top-level worktree");
  }
  const status = await requiredGit(canonicalPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], input.environment);
  if (status !== "") {
    throw new RoleRuntimeError("worktree_not_clean", "role checkout must be clean before a Stage Attempt begins");
  }

  const snapshot = await inspectRepository(canonicalPath, input.environment);
  if (input.candidate === null) {
    if (snapshot.headSha !== input.baseSha || snapshot.symbolicRef !== input.branchRef) {
      throw new RoleRuntimeError("candidate_mismatch", "Builder checkout does not match its exact base and Factory Branch");
    }
  } else if (
    input.candidate.factoryRunId !== input.factoryRunId ||
    snapshot.headSha !== input.candidate.headCommitSha ||
    snapshot.sourceTreeSha !== input.candidate.sourceTreeSha ||
    snapshot.symbolicRef !== input.candidate.branchRef ||
    input.branchRef !== input.candidate.branchRef
  ) {
    throw new RoleRuntimeError("candidate_mismatch", "role checkout is not the exact requested Candidate");
  }
  return snapshot;
}

export async function changedPaths(
  worktreePath: string,
  environment: NodeJS.ProcessEnv
): Promise<readonly string[]> {
  const [tracked, untracked] = await Promise.all([
    requiredGit(worktreePath, ["diff", "--name-only", "-z", "HEAD", "--"], environment),
    requiredGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], environment)
  ]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globRegex(pattern).test(path));
}

export async function evaluatePostconditions(input: Readonly<{
  role: FactoryRole;
  worktreePath: string;
  environment: NodeJS.ProcessEnv;
  before: RepositorySnapshot;
  expectedCandidateHeadSha: string | null;
  expectedCandidateTreeSha: string | null;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  claimedChangedPaths: readonly string[];
  builderRequiresChanges: boolean;
  processGroupAbsent: boolean;
}>): Promise<RolePostconditions> {
  const after = await inspectRepository(input.worktreePath, input.environment);
  const actualChangedPaths = await changedPaths(input.worktreePath, input.environment);
  const diffCheck = await runGit(input.worktreePath, ["diff", "--check", "HEAD", "--"], input.environment);
  const gitHeadUnchanged = input.before.headSha === after.headSha;
  const gitRefsUnchanged = input.before.refsDigest === after.refsDigest;
  const gitIndexUnchanged = input.before.indexDigest === after.indexDigest;
  const sourceTreeUnchanged = input.before.filesDigest === after.filesDigest;
  const forbiddenPathsUnchanged = actualChangedPaths.every(
    (path) => !matchesAny(path, input.forbiddenPaths) && matchesAny(path, input.allowedPaths)
  );

  if (!input.processGroupAbsent) {
    throw new RoleRuntimeError("child_process_leak", "role process group still exists after cancellation");
  }
  if (!gitHeadUnchanged || !gitRefsUnchanged || !gitIndexUnchanged) {
    throw new RoleRuntimeError("unauthorized_write", "role mutated Git HEAD, refs, or index", {
      gitHeadUnchanged,
      gitRefsUnchanged,
      gitIndexUnchanged
    });
  }
  if (input.expectedCandidateHeadSha !== null) {
    if (
      input.before.headSha !== input.expectedCandidateHeadSha ||
      after.headSha !== input.expectedCandidateHeadSha ||
      input.before.sourceTreeSha !== input.expectedCandidateTreeSha ||
      after.sourceTreeSha !== input.expectedCandidateTreeSha
    ) {
      throw new RoleRuntimeError("candidate_mismatch", "Candidate checkout does not match the exact accepted identity");
    }
  }

  if (input.role === "builder") {
    if (input.builderRequiresChanges && actualChangedPaths.length === 0) {
      throw new RoleRuntimeError("worktree_not_clean", "Builder claimed changes_ready without a product change");
    }
    if (!forbiddenPathsUnchanged) {
      throw new RoleRuntimeError("forbidden_path_change", "Builder changed a forbidden or non-allowlisted path", {
        actualChangedPaths
      });
    }
    if (diffCheck.exitCode !== 0) {
      throw new RoleRuntimeError("worktree_not_clean", `git diff --check failed: ${diffCheck.stderr.trim()}`);
    }
    if (
      input.builderRequiresChanges &&
      [...input.claimedChangedPaths].sort().join("\0") !== actualChangedPaths.join("\0")
    ) {
      throw new RoleRuntimeError("stale_input", "Builder changed-path claims do not match the worktree", {
        claimedChangedPaths: input.claimedChangedPaths,
        actualChangedPaths
      });
    }
  } else if (!sourceTreeUnchanged || input.before.statusDigest !== after.statusDigest) {
    throw new RoleRuntimeError("unauthorized_write", `${input.role} mutated the read-only Candidate checkout`, {
      actualChangedPaths
    });
  }

  return {
    role: input.role,
    candidate_head_sha: input.expectedCandidateHeadSha,
    changed_paths: actualChangedPaths,
    git_head_unchanged: gitHeadUnchanged,
    git_refs_unchanged: gitRefsUnchanged,
    git_index_unchanged: gitIndexUnchanged,
    source_tree_unchanged: input.role === "builder" ? false : sourceTreeUnchanged,
    forbidden_paths_unchanged: forbiddenPathsUnchanged,
    diff_check_passed: diffCheck.exitCode === 0,
    process_group_absent: input.processGroupAbsent
  };
}
