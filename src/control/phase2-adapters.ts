import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ProcessCommandRunner } from "./command-runner.js";
import { FileConditionalPollStore } from "./conditional-poll-store.js";
import type {
  GitHubPreflightEvidence,
  SourceCapabilityRecord
} from "./contracts.js";
import { GitHubControlError } from "./errors.js";
import { GhCliGitHubApi } from "./github-cli-api.js";
import { GhCliSourceControlGitHub } from "./github-cli-source-control.js";
import { FileClaimIntentStore, RecoverableGitHubControl } from "./github-control.js";
import {
  FileSourceCapabilityStore,
  sourceCapabilityRecord
} from "./source-capability-store.js";
import { GitSourceControl } from "./source-control.js";

export interface Phase2ControlEnvironment {
  readonly githubControl: RecoverableGitHubControl;
  sourceControlFor(
    github: GitHubPreflightEvidence,
    observedAt: string,
    factoryRunId?: string
  ): Promise<GitSourceControl>;
  bindSourceCapability(factoryRunId: string): Promise<void>;
  bootstrapLinkedBranches(
    github: GitHubPreflightEvidence,
    issueNumber: number,
    observedAt: string
  ): Promise<SourceCapabilityRecord>;
}

export function isConclusiveLinkedBranchUnsupported(message: string): boolean {
  return /(?:not supported|unsupported|unknown (?:field|argument|flag)|(?:linkedBranches|createLinkedBranch).*(?:does not exist|undefined))/i.test(
    message
  );
}

export function createPhase2ControlEnvironment(input: {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
}): Phase2ControlEnvironment {
  const runner = new ProcessCommandRunner();
  const stateRoot = resolve(input.stateRoot);
  const sourceGitHub = new GhCliSourceControlGitHub({ runner });
  const api = new GhCliGitHubApi({
    runner,
    pollStore: new FileConditionalPollStore(resolve(stateRoot, "control", "github-poll.json"))
  });
  const pendingCapabilities = new FileSourceCapabilityStore(
    resolve(stateRoot, "control", "source-capability-pending.json")
  );
  const bootstrapCapabilities = new FileSourceCapabilityStore(
    resolve(stateRoot, "control", "linked-branch-bootstrap.json")
  );
  const runCapabilities = (factoryRunId: string): FileSourceCapabilityStore =>
    new FileSourceCapabilityStore(
      resolve(stateRoot, "runs", factoryRunId, "source-capability.json")
    );

  const sourceControl = (capability: SourceCapabilityRecord): GitSourceControl =>
    new GitSourceControl({
      runner,
      github: sourceGitHub,
      config: {
        repositoryRoot: resolve(input.repositoryRoot),
        stateRoot,
        remoteName: "origin",
        expectedRemoteUrl: "git@github.org.com:engineering/agentic-software-factory.git",
        defaultBranch: "main",
        repository: "github.org.com/engineering/agentic-software-factory",
        branchMode: capability.selectedBranchMode,
        branchModeEvidence: capability.evidence,
        expectedGitVersion: "2.47.1",
        expectedGitHubCliVersion: "2.96.0"
      }
    });

  const selectedCapability = async (
    github: GitHubPreflightEvidence,
    observedAt: string,
    target: FileSourceCapabilityStore
  ): Promise<SourceCapabilityRecord> => {
    const existing = await target.load();
    if (existing !== null) return existing;
    if (github.linkedBranchCapability === "unsupported") {
      return target.save(sourceCapabilityRecord({
        github,
        observedAt,
        selectedBranchMode: "pure_git",
        evidence: github.linkedBranchCapabilityEvidence
      }));
    }
    const bootstrap = await bootstrapCapabilities.load();
    if (
      bootstrap === null ||
      bootstrap.gitHubCliVersion !== github.cliVersion ||
      bootstrap.host !== github.host ||
      bootstrap.repository !== github.repository
    ) {
      throw new GitHubControlError(
        "github_blocked_capability",
        "linked branches require factory bootstrap-source-control against the exact installed CLI/server path"
      );
    }
    return target.save(sourceCapabilityRecord({
      github,
      observedAt,
      selectedBranchMode: bootstrap.selectedBranchMode,
      evidence: bootstrap.evidence
    }));
  };

  return {
    githubControl: new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(resolve(stateRoot, "control", "claim-intent.json"))
    }),
    async sourceControlFor(github, observedAt, factoryRunId) {
      const store = factoryRunId === undefined
        ? pendingCapabilities
        : runCapabilities(factoryRunId);
      return sourceControl(await selectedCapability(github, observedAt, store));
    },
    async bindSourceCapability(factoryRunId) {
      const runStore = runCapabilities(factoryRunId);
      if (await runStore.load() !== null) return;
      const pending = await pendingCapabilities.load();
      if (pending === null) {
        throw new Error("source_control_conflict: no pending source capability to bind to the Factory Run");
      }
      await runStore.save(pending);
      await pendingCapabilities.remove();
    },
    async bootstrapLinkedBranches(github, issueNumber, observedAt) {
      if (github.linkedBranchCapability === "unsupported") {
        return bootstrapCapabilities.save(sourceCapabilityRecord({
          github,
          observedAt,
          selectedBranchMode: "pure_git",
          evidence: github.linkedBranchCapabilityEvidence
        }));
      }

      const bootstrapSource = sourceControl(sourceCapabilityRecord({
        github,
        observedAt,
        selectedBranchMode: "pure_git",
        evidence: "temporary pure-Git mode for linked-branch bootstrap preflight"
      }));
      const preflight = await bootstrapSource.preflight();
      const branch = `factory-capability-probe/${randomUUID()}`;
      const branchRef = `refs/heads/${branch}`;
      let remoteSha: string | null = null;
      try {
        await sourceGitHub.createLinkedBranch({
          issueNumber,
          branch,
          baseBranch: "main"
        });
        const linked = await sourceGitHub.listLinkedBranches(issueNumber);
        if (linked.filter((candidate) => candidate === branch).length !== 1) {
          throw new GitHubControlError(
            "github_conflict",
            "linked-branch bootstrap did not read back exactly one issue link"
          );
        }
        const remote = await runner.run({
          command: "git",
          args: ["ls-remote", "origin", branchRef],
          cwd: resolve(input.repositoryRoot)
        });
        if (remote.exitCode !== 0) {
          throw new Error(`linked-branch bootstrap ls-remote failed: ${remote.stderr.trim()}`);
        }
        remoteSha = remote.stdout.trim().split(/\s+/, 1)[0] ?? null;
        if (remoteSha !== preflight.defaultBranchSha) {
          throw new GitHubControlError(
            "github_conflict",
            "linked-branch bootstrap branch did not use the verified default-branch SHA"
          );
        }
        return await bootstrapCapabilities.save(sourceCapabilityRecord({
          github,
          observedAt,
          selectedBranchMode: "linked",
          evidence: `exact gh issue develop + GraphQL read-back succeeded for issue #${issueNumber}`
        }));
      } catch (error) {
        if (
          error instanceof GitHubControlError &&
          error.code === "github_blocked_capability" &&
          isConclusiveLinkedBranchUnsupported(error.message)
        ) {
          return bootstrapCapabilities.save(sourceCapabilityRecord({
            github,
            observedAt,
            selectedBranchMode: "pure_git",
            evidence: `exact linked-branch bootstrap classified unsupported: ${error.message}`
          }));
        }
        throw error;
      } finally {
        if (remoteSha === null) {
          const uncertain = await runner.run({
            command: "git",
            args: ["ls-remote", "origin", branchRef],
            cwd: resolve(input.repositoryRoot)
          });
          if (uncertain.exitCode !== 0) {
            throw new Error(`linked-branch bootstrap reconciliation failed: ${uncertain.stderr.trim()}`);
          }
          remoteSha = uncertain.stdout.trim().split(/\s+/, 1)[0] ?? null;
        }
        if (remoteSha !== null && remoteSha !== "") {
          const deletion = await runner.run({
            command: "git",
            args: [
              "push",
              `--force-with-lease=${branchRef}:${remoteSha}`,
              "origin",
              `:${branchRef}`
            ],
            cwd: resolve(input.repositoryRoot)
          });
          if (deletion.exitCode !== 0) {
            throw new Error(`linked-branch bootstrap cleanup failed: ${deletion.stderr.trim()}`);
          }
          const remaining = await runner.run({
            command: "git",
            args: ["ls-remote", "origin", branchRef],
            cwd: resolve(input.repositoryRoot)
          });
          if (remaining.exitCode !== 0 || remaining.stdout.trim() !== "") {
            throw new Error("linked-branch bootstrap cleanup did not remove the exact probe branch");
          }
        }
      }
    }
  };
}
