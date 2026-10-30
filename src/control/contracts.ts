import type {
  Digest,
  EffectInvocationContext,
  FactoryRunId,
  GitObjectId,
  IssueId,
  TerminalOutcome
} from "../protocol/contracts.js";
import type { TerminalFactoryLabel } from "./config.js";

export interface FactoryIssue {
  readonly issueId: IssueId;
  readonly number: number;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
  readonly url: string;
  readonly createdAt: string;
}

export interface GitHubControlConfig {
  readonly host: "github.org.com";
  readonly repository: "engineering/agentic-software-factory";
  readonly defaultBranch: "main";
  readonly expectedCliVersion: "2.96.0";
  readonly expectedEnterpriseVersion: "3.19.10";
  readonly restApiVersion: "2022-11-28";
  readonly factoryLogin: "GH_ENTERPRISE_USERNAME";
}

export interface GitHubPreflightObservation {
  readonly cliVersion: string;
  readonly authenticated: boolean;
  readonly login: string | null;
  readonly enterpriseVersion: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly issuesEnabled: boolean;
  readonly permission: "none" | "read" | "triage" | "write" | "maintain" | "admin";
  readonly labels: readonly Readonly<{ name: string; color: string; description: string }>[];
  readonly linkedBranchCapability: "supported" | "unsupported";
  readonly linkedBranchCapabilityEvidence: string;
  readonly readable: Readonly<{
    issues: boolean;
    comments: boolean;
    pullRequests: boolean;
    defaultBranchCommit: boolean;
    commitStatuses: boolean;
  }>;
}

export interface GitHubPreflightEvidence extends GitHubPreflightObservation {
  readonly host: string;
  readonly restApiVersion: string;
}

export type CommitStatusState = "pending" | "success" | "failure" | "error";

export interface GitHubCommitStatusRecord {
  readonly id: number;
  readonly candidateSha: GitObjectId;
  readonly context: string;
  readonly state: CommitStatusState;
  readonly description: string;
  readonly targetUrl: string;
  readonly url: string;
}

export interface IssueEventReceipt {
  readonly eventId: string;
  readonly commentId: number;
  readonly commentUrl: string;
  readonly bodyDigest: Digest;
}

export interface TerminalProjectionReceipt {
  readonly terminalOutcome: TerminalOutcome;
  readonly terminalLabel: TerminalFactoryLabel;
  readonly issueState: "open" | "closed";
  readonly comment: IssueEventReceipt;
  readonly rolloutStatus: GitHubCommitStatusRecord | null;
}

export interface ClaimPlan {
  readonly context: EffectInvocationContext;
  readonly claimEventId: string;
  readonly claimedAt: string;
}

export interface ClaimReceipt {
  readonly factoryRunId: FactoryRunId;
  readonly issue: FactoryIssue;
  readonly commentId: number;
  readonly commentUrl: string;
  readonly verifiedAt: string;
}

export type ClaimOutcome =
  | { readonly status: "claimed"; readonly claim: ClaimReceipt }
  | { readonly status: "no_work" }
  | { readonly status: "paused"; readonly reason: "github_conflict"; readonly detail: string };

export interface PullRequestRecord {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly headBranch: string;
  readonly headSha: GitObjectId;
  readonly baseBranch: string;
  readonly mergeCommitSha: GitObjectId | null;
}

export interface SourceControlConfig {
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly remoteName: string;
  readonly expectedRemoteUrl: string;
  readonly defaultBranch: string;
  readonly repository: string;
  readonly branchMode: "linked" | "pure_git";
  readonly branchModeEvidence: string;
  readonly expectedGitVersion: string;
  readonly expectedGitHubCliVersion: string;
}

export interface SourceControlPreflight {
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly remoteUrl: string;
  readonly defaultBranchSha: GitObjectId;
  readonly gitVersion: string;
  readonly gitHubCliVersion: string;
  readonly branchMode: "linked" | "pure_git";
  readonly branchModeEvidence: string;
  readonly primaryCheckoutDirty: boolean;
  readonly stateRootAvailableBytes: number;
  readonly gitConfig: Readonly<{
    objectFormat: string;
    hooksPath: string | null;
    commitGpgSign: string | null;
  }>;
}

export interface PreparedSource {
  readonly factoryRunId: FactoryRunId;
  readonly branchName: string;
  readonly branchRef: string;
  readonly worktreePath: string;
  readonly baseSha: GitObjectId;
  readonly branchMode: "linked" | "pure_git";
}

export interface SourceCapabilityRecord {
  readonly schemaVersion: "1.0";
  readonly contract: "source_capability";
  readonly host: "github.org.com";
  readonly repository: "engineering/agentic-software-factory";
  readonly gitHubCliVersion: string;
  readonly linkedBranches: "supported" | "unsupported";
  readonly selectedBranchMode: "linked" | "pure_git";
  readonly evidence: string;
  readonly observedAt: string;
}

export type TerminalBranchObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly branchRef: string;
      readonly remoteSha: GitObjectId;
    };

export type TerminalCleanupRefObservation =
  | { readonly state: "absent"; readonly sha: null }
  | { readonly state: "present"; readonly sha: GitObjectId };

export type TerminalCleanupPullRequestObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "open" | "closed" | "merged";
      readonly number: number;
      readonly headSha: GitObjectId;
    }
  | {
      readonly state: "ambiguous";
      readonly entries: readonly Readonly<{
        state: "open" | "closed" | "merged";
        number: number;
        headSha: GitObjectId;
      }>[];
    };

export type TerminalCleanupWorktreeObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "locked";
      readonly path: string;
      readonly branchRef: string;
      readonly headSha: GitObjectId;
      readonly dirty: boolean | null;
    }
  | {
      readonly state: "ambiguous";
      readonly entries: readonly Readonly<{
        path: string;
        branchRef: string | null;
        headSha: GitObjectId;
        locked: boolean;
      }>[];
    };

interface TerminalCleanupReceiptBase {
  readonly schemaVersion: "1.0";
  readonly contract: "terminal_cleanup_receipt";
  readonly localBranch: TerminalCleanupRefObservation;
  readonly remoteBranch: TerminalCleanupRefObservation;
}

export type TerminalCleanupReceipt =
  | (TerminalCleanupReceiptBase & {
      readonly status: "complete";
      readonly terminalOutcome: "succeeded";
      readonly worktree: { readonly state: "absent" };
      readonly localBranch: { readonly state: "absent"; readonly sha: null };
      readonly remoteBranch: { readonly state: "absent"; readonly sha: null };
      readonly pullRequest: Readonly<{
        state: "merged";
        number: number;
        headSha: GitObjectId;
      }>;
    })
  | (TerminalCleanupReceiptBase & {
      readonly status: "complete";
      readonly terminalOutcome: Exclude<TerminalOutcome, "succeeded">;
      readonly worktree: { readonly state: "absent" };
      readonly pullRequest:
        | { readonly state: "absent" }
        | Readonly<{ state: "closed"; number: number; headSha: GitObjectId }>;
    })
  | (TerminalCleanupReceiptBase & {
      readonly status: "pending_cleanup";
      readonly terminalOutcome: TerminalOutcome;
      readonly worktree: TerminalCleanupWorktreeObservation;
      readonly pullRequest: TerminalCleanupPullRequestObservation;
      readonly reason: string;
    });
