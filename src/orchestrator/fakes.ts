import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  parseDigest,
  parseFactoryRunId,
  parseGitObjectId,
  parseIssueId,
  parseStageAttemptId,
  type CandidateRelease,
  type Digest,
  type WorkerResult
} from "../protocol/contracts.js";
import {
  REQUIRED_FACTORY_LABELS,
  TERMINAL_FACTORY_LABEL_BY_OUTCOME,
  TERMINAL_ROLLOUT_STATUS_BY_OUTCOME
} from "../control/config.js";
import type { FactoryIssue } from "../control/ports.js";
import type { PreparedSource } from "../control/contracts.js";
import type { BuilderResult, ReviewerResult, VerifierResult } from "../roles/port.js";
import type { OrchestratorAdapters } from "./ports.js";

const digest = (character: string): Digest => parseDigest(character.repeat(64));

class DeterministicClock {
  #tick = 0;

  now(): string {
    const instant = new Date(Date.UTC(2026, 8, 28, 12, 0, this.#tick));
    this.#tick += 1;
    return instant.toISOString();
  }
}

class DeterministicIdGenerator {
  readonly #counters = new Map<string, number>();

  next(prefix: "az" | "evt" | "fe" | "fx" | "fr"): string {
    const next = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, next);
    return `${prefix}_fixture_${String(next).padStart(3, "0")}`;
  }
}

export interface FixtureAdapters {
  readonly adapters: OrchestratorAdapters;
  readonly calls: string[];
}

export function createFixtureAdapters(): FixtureAdapters {
  const calls: string[] = [];
  const issue: FactoryIssue = {
    issueId: parseIssueId("41"),
    number: 41,
    title: "Fixture Candidate",
    acceptanceCriteria: ["Traverse every gated Stage without external mutation"],
    url: "https://github.org.com/engineering/agentic-software-factory/issues/41",
    createdAt: "2026-09-28T11:00:00.000Z"
  };
  const candidate: CandidateRelease = {
    schemaVersion: "1.0",
    contract: "candidate_release",
    factoryRunId: parseFactoryRunId("fr_fixture_001"),
    candidateOrdinal: 1,
    builderStageAttemptId: parseStageAttemptId("fa_builder_001"),
    branchRef: "refs/heads/factory/fixture",
    baseSha: parseGitObjectId("0000000000000000000000000000000000000000"),
    headCommitSha: parseGitObjectId("1111111111111111111111111111111111111111"),
    sourceTreeSha: parseGitObjectId("2222222222222222222222222222222222222222")
  };
  const prepared: PreparedSource = {
    factoryRunId: candidate.factoryRunId,
    branchName: "factory/issue-41/fr_fixture_001",
    branchRef: candidate.branchRef,
    worktreePath: "/factory-state/runs/fr_fixture_001/worktree",
    baseSha: candidate.baseSha,
    branchMode: "pure_git"
  };
  const build: BuilderResult = {
    decision: "changes_ready",
    stageAttemptId: parseStageAttemptId("fa_builder_001"),
    builderEvidenceDigest: digest("a"),
    summary: "Deterministic fixture Candidate is ready"
  };
  const verification: VerifierResult = {
    decision: "passed",
    candidateHeadSha: candidate.headCommitSha,
    evidenceDigest: digest("b")
  };
  const review: ReviewerResult = {
    decision: "review_complete",
    review: {
      candidateHeadSha: candidate.headCommitSha,
      disposition: "review_complete",
      riskClassification: "low",
      evidenceDigest: digest("c")
    }
  };

  return {
    calls,
    adapters: {
      clock: new DeterministicClock(),
      idGenerator: new DeterministicIdGenerator(),
      githubControl: {
        async preflight() {
          calls.push("GitHubControl.preflight");
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
            linkedBranchCapability: "supported" as const,
            linkedBranchCapabilityEvidence: "fixture capability probe",
            readable: { issues: true, comments: true, pullRequests: true, defaultBranchCommit: true, commitStatuses: true },
            host: "github.org.com",
            restApiVersion: "2022-11-28"
          };
        },
        async claimOldestReady(plan) {
          calls.push("GitHubControl.claimOldestReady");
          if (plan.context.factoryRunId !== candidate.factoryRunId) throw new Error("unexpected fixture run ID");
          return {
            status: "claimed" as const,
            claim: {
              factoryRunId: candidate.factoryRunId,
              issue,
              commentId: 1,
              commentUrl: "https://github.org.com/comment/1",
              verifiedAt: plan.claimedAt
            }
          };
        },
        async reconcilePendingClaim() {
          calls.push("GitHubControl.reconcilePendingClaim");
          return { status: "no_work" as const };
        },
        async acceptClaim() {
          calls.push("GitHubControl.acceptClaim");
        },
        async loadIssue(): Promise<FactoryIssue> {
          calls.push("GitHubControl.loadIssue");
          return issue;
        },
        async publishIssueEvent(input) {
          calls.push("GitHubControl.publishIssueEvent");
          return { eventId: input.eventId, commentId: 2, commentUrl: "https://github.org.com/comment/2", bodyDigest: canonicalSha256(input.body) };
        },
        async publishCommitStatus(input) {
          calls.push("GitHubControl.publishCommitStatus");
          return { id: 1, candidateSha: input.candidateSha, context: input.context, state: input.state, description: input.description, targetUrl: input.targetUrl, url: "https://github.org.com/status/1" };
        },
        async projectTerminal(input) {
          calls.push("GitHubControl.projectTerminal");
          const rolloutProjection = TERMINAL_ROLLOUT_STATUS_BY_OUTCOME[input.terminalOutcome];
          return {
            terminalOutcome: input.terminalOutcome,
            terminalLabel: TERMINAL_FACTORY_LABEL_BY_OUTCOME[input.terminalOutcome],
            issueState: input.terminalOutcome === "succeeded" ? "closed" as const : "open" as const,
            comment: {
              eventId: `fe_${input.invocation.effectIntentId.slice("fx_".length)}`,
              commentId: 3,
              commentUrl: "https://github.org.com/comment/3",
              bodyDigest: digest("9")
            },
            rolloutStatus: input.candidateSha === null || rolloutProjection === null
              ? null
              : {
                  id: 2,
                  candidateSha: input.candidateSha,
                  context: "factory/rollout",
                  state: rolloutProjection.state,
                  description: rolloutProjection.description,
                  targetUrl: "https://github.org.com/comment/3",
                  url: "https://github.org.com/status/2"
                }
          };
        }
      },
      sourceControl: {
        async preflight() {
          calls.push("SourceControl.preflight");
          return { repositoryRoot: "/repo", commonGitDirectory: "/repo/.git", remoteUrl: "git@github.org.com:engineering/agentic-software-factory.git", defaultBranchSha: candidate.baseSha, gitVersion: "2.47.1", gitHubCliVersion: "2.96.0", branchMode: "pure_git" as const, branchModeEvidence: "fixture fallback classification", primaryCheckoutDirty: true, stateRootAvailableBytes: 1_000_000_000, gitConfig: { objectFormat: "sha1", hooksPath: null, commitGpgSign: null } };
        },
        async prepareRun(input) {
          calls.push("SourceControl.prepareRun");
          if (input.context.factoryRunId !== candidate.factoryRunId || input.baseSha !== candidate.baseSha) throw new Error("unexpected fixture source identity");
          return prepared;
        },
        async createCandidate(input): Promise<CandidateRelease> {
          calls.push("SourceControl.createCandidate");
          if (input.context.factoryRunId !== candidate.factoryRunId || input.prepared.branchRef !== candidate.branchRef || input.build.stageAttemptId !== candidate.builderStageAttemptId) {
            throw new Error("fixture SourceControl received an unexpected identity");
          }
          return candidate;
        },
        async readyCandidate(input) {
          calls.push("SourceControl.readyCandidate");
          return { number: 1, url: "https://github.org.com/pr/1", state: "open" as const, isDraft: false, headBranch: prepared.branchName, headSha: input.candidate.headCommitSha, baseBranch: "main", mergeCommitSha: null };
        },
        async readPullRequest(input) {
          return { number: input.number, url: "https://github.org.com/pr/1", state: "open" as const, isDraft: true, headBranch: prepared.branchName, headSha: input.expectedHeadSha, baseBranch: "main", mergeCommitSha: null };
        },
        async integrateCandidate(input) {
          calls.push("SourceControl.integrateCandidate");
          if (input.candidate.headCommitSha !== candidate.headCommitSha) throw new Error("stale fixture integration");
          return { integrationCommitSha: parseGitObjectId("3333333333333333333333333333333333333333"), sourceTreeSha: candidate.sourceTreeSha };
        },
        async observeTerminalBranch() {
          calls.push("SourceControl.observeTerminalBranch");
          return { state: "absent" as const };
        },
        async cleanupTerminal(input) {
          calls.push("SourceControl.cleanupTerminal");
          if (input.terminalOutcome === "succeeded") {
            return {
              schemaVersion: "1.0" as const,
              contract: "terminal_cleanup_receipt" as const,
              status: "complete" as const,
              terminalOutcome: "succeeded" as const,
              worktree: { state: "absent" as const },
              localBranch: { state: "absent" as const, sha: null },
              remoteBranch: { state: "absent" as const, sha: null },
              pullRequest: { state: "merged" as const, number: 1, headSha: candidate.headCommitSha }
            };
          }
          return {
            schemaVersion: "1.0" as const,
            contract: "terminal_cleanup_receipt" as const,
            status: "complete" as const,
            terminalOutcome: input.terminalOutcome,
            worktree: { state: "absent" as const },
            localBranch: { state: "present" as const, sha: candidate.headCommitSha },
            remoteBranch: { state: "present" as const, sha: candidate.headCommitSha },
            pullRequest: { state: "closed" as const, number: 1, headSha: candidate.headCommitSha }
          };
        }
      },
      roleRuntime: {
        async runBuilder(input): Promise<BuilderResult> {
          calls.push("RoleRuntime.runBuilder");
          if (input.context.factoryRunId !== candidate.factoryRunId || input.issue.issueId !== issue.issueId || input.preparedSource.branchRef !== prepared.branchRef) {
            throw new Error("fixture Builder received an unexpected identity");
          }
          return build;
        },
        async runVerifier(input): Promise<VerifierResult> {
          calls.push("RoleRuntime.runVerifier");
          if (input.candidate.headCommitSha !== candidate.headCommitSha) {
            throw new Error("fixture Verifier received a stale Candidate");
          }
          return verification;
        },
        async runReviewer(input): Promise<ReviewerResult> {
          calls.push("RoleRuntime.runReviewer");
          if (input.candidate.headCommitSha !== candidate.headCommitSha) {
            throw new Error("fixture Reviewer received a stale Candidate");
          }
          return review;
        }
      },
      releaseTopology: {
        async prepareRollout(input) {
          calls.push("ReleaseTopology.prepareRollout");
          if (input.candidate.headCommitSha !== candidate.headCommitSha) {
            throw new Error("fixture ReleaseTopology received a stale Candidate");
          }
          return {
            candidateHeadSha: candidate.headCommitSha,
            stagingPassed: true,
            allProgressiveGatesPassed: true,
            candidateExposureBasisPoints: 10000,
            stableAvailable: true,
            evidenceDigest: digest("d")
          };
        }
      },
      telemetryEngine: {
        async evaluateRollout(input): Promise<WorkerResult> {
          calls.push("TelemetryEngine.evaluateRollout");
          return {
            schemaVersion: "1.0",
            contract: "worker_result",
            role: "rollout_babysitter",
            factoryRunId: input.context.factoryRunId,
            candidateHeadSha: input.candidate.headCommitSha,
            inputSha256: canonicalSha256({
              factoryRunId: input.context.factoryRunId,
              candidate: input.candidate,
              rollout: input.rollout
            }),
            decision: "enter_observation",
            facts: {
              candidateExposureBasisPoints: input.rollout.candidateExposureBasisPoints,
              stableAvailable: input.rollout.stableAvailable
            }
          };
        },
        async evaluateObservation(input): Promise<WorkerResult> {
          calls.push("TelemetryEngine.evaluateObservation");
          return {
            schemaVersion: "1.0",
            contract: "worker_result",
            role: "rollout_babysitter",
            factoryRunId: input.context.factoryRunId,
            candidateHeadSha: input.candidate.headCommitSha,
            inputSha256: canonicalSha256({
              factoryRunId: input.context.factoryRunId,
              candidate: input.candidate
            }),
            decision: "observation_passed",
            facts: {
              observationComplete: true,
              telemetryPassed: true,
              unresolvedIncidentCount: 0
            }
          };
        }
      }
    }
  };
}
