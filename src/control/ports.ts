import type {
  CandidateRelease,
  EffectInvocationContext,
  TerminalOutcome
} from "../protocol/contracts.js";
import type { BuilderResult } from "../roles/port.js";
import type {
  ClaimOutcome,
  ClaimPlan,
  CommitStatusState,
  FactoryIssue,
  GitHubCommitStatusRecord,
  GitHubPreflightEvidence,
  IssueEventReceipt,
  PreparedSource,
  PullRequestRecord,
  SourceControlPreflight,
  TerminalBranchObservation,
  TerminalCleanupReceipt,
  TerminalProjectionReceipt
} from "./contracts.js";

export type {
  FactoryIssue,
  PreparedSource
} from "./contracts.js";

export interface GitHubControl {
  preflight(): Promise<GitHubPreflightEvidence>;
  claimOldestReady(plan: ClaimPlan): Promise<ClaimOutcome>;
  reconcilePendingClaim(): Promise<ClaimOutcome>;
  acceptClaim(factoryRunId: CandidateRelease["factoryRunId"]): Promise<void>;
  loadIssue(issueId: FactoryIssue["issueId"]): Promise<FactoryIssue>;
  publishIssueEvent(input: {
    readonly invocation: EffectInvocationContext;
    readonly issueNumber: number;
    readonly eventId: string;
    readonly event: string;
    readonly candidateSha: CandidateRelease["headCommitSha"] | null;
    readonly body: string;
  }): Promise<IssueEventReceipt>;
  publishCommitStatus(input: {
    readonly invocation: EffectInvocationContext;
    readonly candidateSha: CandidateRelease["headCommitSha"];
    readonly context: string;
    readonly state: CommitStatusState;
    readonly description: string;
    readonly targetUrl: string;
  }): Promise<GitHubCommitStatusRecord>;
  projectTerminal(input: {
    readonly invocation: EffectInvocationContext;
    readonly issueNumber: number;
    readonly terminalOutcome: TerminalOutcome;
    readonly candidateSha: CandidateRelease["headCommitSha"] | null;
    readonly branchRef: CandidateRelease["branchRef"] | null;
  }): Promise<TerminalProjectionReceipt>;
}

export interface SourceControl {
  preflight(input?: Readonly<{
    knownFactoryRunId: CandidateRelease["factoryRunId"];
    knownIssueNumber: number;
  }>): Promise<SourceControlPreflight>;
  prepareRun(input: {
    readonly context: EffectInvocationContext;
    readonly issueNumber: number;
    readonly baseSha: CandidateRelease["baseSha"];
  }): Promise<PreparedSource>;
  createCandidate(input: {
    readonly context: EffectInvocationContext;
    readonly prepared: PreparedSource;
    readonly issueNumber: number;
    readonly candidateOrdinal: number;
    readonly previousCandidateHeadSha: CandidateRelease["headCommitSha"] | null;
    readonly build: BuilderResult;
  }): Promise<CandidateRelease>;
  readyCandidate(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
  }): Promise<PullRequestRecord>;
  readPullRequest(input: {
    readonly number: number;
    readonly expectedHeadSha: CandidateRelease["headCommitSha"];
  }): Promise<PullRequestRecord>;
  integrateCandidate(input: {
    readonly context: EffectInvocationContext;
    readonly candidate: CandidateRelease;
    readonly pullRequestNumber?: number;
  }): Promise<Readonly<{
    integrationCommitSha: CandidateRelease["headCommitSha"];
    sourceTreeSha: CandidateRelease["sourceTreeSha"];
  }>>;
  observeTerminalBranch(input: {
    readonly context: EffectInvocationContext;
    readonly issueNumber: number;
  }): Promise<TerminalBranchObservation>;
  cleanupTerminal(input: {
    readonly context: EffectInvocationContext;
    readonly issueNumber: number;
    readonly terminalOutcome: TerminalOutcome;
    readonly candidate: CandidateRelease | null;
  }): Promise<TerminalCleanupReceipt>;
}
