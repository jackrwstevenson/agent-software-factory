import type { FactoryRunId, GitObjectId } from "../protocol/contracts.js";
import type {
  CommitStatusState,
  GitHubCommitStatusRecord,
  GitHubPreflightObservation,
  PullRequestRecord
} from "./contracts.js";

export interface GitHubIssueRecord {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  assignees: string[];
  pullRequest?: boolean;
}

export interface GitHubCommentRecord {
  readonly id: number;
  readonly body: string;
  readonly url: string;
}

export interface GitHubApi {
  preflight(): Promise<GitHubPreflightObservation>;
  listReadyIssues(): Promise<readonly GitHubIssueRecord[]>;
  getIssue(issueNumber: number): Promise<GitHubIssueRecord>;
  listIssueComments(issueNumber: number): Promise<readonly GitHubCommentRecord[]>;
  updateIssueClaim(input: {
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
  }): Promise<GitHubIssueRecord>;
  updateIssueProjection(input: {
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly state: "open" | "closed";
  }): Promise<GitHubIssueRecord>;
  createIssueComment(input: {
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<GitHubCommentRecord>;
  listCommitStatuses(candidateSha: GitObjectId): Promise<readonly GitHubCommitStatusRecord[]>;
  createCommitStatus(input: {
    readonly candidateSha: GitObjectId;
    readonly context: string;
    readonly state: CommitStatusState;
    readonly description: string;
    readonly targetUrl: string;
  }): Promise<GitHubCommitStatusRecord>;
}

export interface SourceControlGitHub {
  listLinkedBranches(issueNumber: number): Promise<readonly string[]>;
  createLinkedBranch(input: {
    readonly issueNumber: number;
    readonly branch: string;
    readonly baseBranch: string;
  }): Promise<void>;
  listPullRequests(headBranch: string): Promise<readonly PullRequestRecord[]>;
  createDraftPullRequest(input: {
    readonly issueNumber: number;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: GitObjectId;
    readonly title: string;
    readonly body: string;
  }): Promise<PullRequestRecord>;
  getPullRequest(number: number): Promise<PullRequestRecord>;
  markPullRequestReady(number: number): Promise<PullRequestRecord>;
  requiredChecksPass(input: {
    readonly number: number;
    readonly expectedHeadSha: GitObjectId;
  }): Promise<boolean>;
  mergePullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: GitObjectId;
  }): Promise<PullRequestRecord>;
  closePullRequest(number: number): Promise<PullRequestRecord>;
}

export interface ClaimIntentStore<TClaimIntent> {
  load(): Promise<TClaimIntent | null>;
  save(intent: TClaimIntent): Promise<void>;
  accept(factoryRunId: FactoryRunId): Promise<void>;
}
