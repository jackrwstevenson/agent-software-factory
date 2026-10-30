import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  parseFactoryRunId,
  parseGitObjectId,
  type Digest,
  type FactoryRunId,
  type GitObjectId,
  type IssueId
} from "../protocol/contracts.js";

export type HumanAuthorizationCommand =
  | { readonly kind: "approve"; readonly factoryRunId: FactoryRunId; readonly candidateHeadSha: GitObjectId }
  | { readonly kind: "reject"; readonly factoryRunId: FactoryRunId; readonly candidateHeadSha: GitObjectId; readonly reason: string }
  | { readonly kind: "abort"; readonly factoryRunId: FactoryRunId; readonly reason: string };

export function parseHumanAuthorizationCommand(body: string): HumanAuthorizationCommand | null {
  const text = body.trim();
  let match = /^\/factory approve (fr_[a-z0-9][a-z0-9_-]{2,63}) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(text);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { kind: "approve", factoryRunId: parseFactoryRunId(match[1]), candidateHeadSha: parseGitObjectId(match[2]) };
  }
  match = /^\/factory reject (fr_[a-z0-9][a-z0-9_-]{2,63}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S(?:.|\n)*)$/.exec(text);
  if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
    return { kind: "reject", factoryRunId: parseFactoryRunId(match[1]), candidateHeadSha: parseGitObjectId(match[2]), reason: match[3].trim() };
  }
  match = /^\/factory abort (fr_[a-z0-9][a-z0-9_-]{2,63}) (\S(?:.|\n)*)$/.exec(text);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { kind: "abort", factoryRunId: parseFactoryRunId(match[1]), reason: match[2].trim() };
  }
  return null;
}

export type RepositoryPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export interface HumanAuthorizationComment {
  readonly issueId: IssueId;
  readonly commentId: number;
  readonly url: string;
  readonly authorLogin: string;
  readonly authorPermission: RepositoryPermission;
  readonly createdAt: string;
  readonly body: string;
  readonly factoryAuthored: boolean;
  readonly containsFactoryEventMarker: boolean;
}

export interface AuthorizationGuardFacts {
  readonly expectedIssueId: IssueId;
  readonly expectedFactoryRunId: FactoryRunId;
  readonly expectedCandidateHeadSha: GitObjectId;
  readonly lifecycleState: "awaiting_human_authorization" | "authorizing" | "paused_for_operator";
  readonly riskClassification: "elevated" | "low" | "prohibited";
  readonly allowedLogins: readonly string[];
  readonly minimumPermission: "admin";
  readonly pullRequestHeadSha: GitObjectId;
  readonly authorizationRequest: {
    readonly commentId: number;
    readonly url: string;
    readonly createdAt: string;
  };
  readonly evidenceComplete: boolean;
  readonly verificationPassed: boolean;
  readonly reviewComplete: boolean;
  readonly sourceGuardsPassed: boolean;
  readonly unresolvedIncidentCount: number;
}

export interface AuthorizationCommandProvenance {
  readonly issueId: IssueId;
  readonly requestCommentId: number;
  readonly requestCommentUrl: string;
  readonly decisionCommentId: number;
  readonly decisionCommentUrl: string;
  readonly actorLogin: string;
  readonly permission: RepositoryPermission;
  readonly createdAt: string;
  readonly bodyDigest: Digest;
  readonly factoryRunId: FactoryRunId;
  readonly candidateHeadSha: GitObjectId | null;
}

export interface AuthorizationCommentEvaluation {
  readonly commentId: number;
  readonly status: "accepted" | "ignored" | "stale" | "blocked";
  readonly reason: string | null;
}

export type AuthorizationCommandSelection =
  | {
      readonly status: "accepted";
      readonly command: HumanAuthorizationCommand;
      readonly provenance: AuthorizationCommandProvenance;
      readonly evaluations: readonly AuthorizationCommentEvaluation[];
    }
  | { readonly status: "none"; readonly evaluations: readonly AuthorizationCommentEvaluation[] };

function evaluateComment(
  comment: HumanAuthorizationComment,
  facts: AuthorizationGuardFacts
): { readonly evaluation: AuthorizationCommentEvaluation; readonly command: HumanAuthorizationCommand | null } {
  const command = parseHumanAuthorizationCommand(comment.body);
  const result = (status: AuthorizationCommentEvaluation["status"], reason: string | null) => ({
    evaluation: { commentId: comment.commentId, status, reason },
    command
  });
  if (command === null) return result("ignored", "comment is not an exact Factory command");
  if (comment.issueId !== facts.expectedIssueId) return result("stale", "command is on another issue");
  if (comment.factoryAuthored || comment.containsFactoryEventMarker) return result("ignored", "factory-authored or marker-bearing commands are inert");
  if (!facts.allowedLogins.includes(comment.authorLogin)) return result("ignored", "command author is not allowlisted");
  if (facts.minimumPermission !== "admin" || comment.authorPermission !== "admin") {
    return result("ignored", "command author lacks configured admin permission");
  }
  if (command.factoryRunId !== facts.expectedFactoryRunId) return result("stale", "command targets another Factory Run");
  if (command.kind !== "abort") {
    if (
      comment.commentId <= facts.authorizationRequest.commentId ||
      Date.parse(comment.createdAt) <= Date.parse(facts.authorizationRequest.createdAt)
    ) return result("stale", "command predates the matching Authorization request");
    if (command.candidateHeadSha !== facts.expectedCandidateHeadSha || facts.pullRequestHeadSha !== facts.expectedCandidateHeadSha) {
      return result("stale", "command or pull request does not bind the exact Candidate");
    }
    if (facts.lifecycleState !== "awaiting_human_authorization" || facts.riskClassification !== "elevated") {
      return result("blocked", "approval or rejection is valid only for the exact Elevated Authorization wait");
    }
  }
  if (command.kind === "approve") {
    if (!facts.evidenceComplete || !facts.verificationPassed || !facts.reviewComplete || !facts.sourceGuardsPassed) {
      return result("blocked", "approval cannot waive incomplete or failed evidence");
    }
    if (facts.unresolvedIncidentCount !== 0) return result("blocked", "approval cannot waive open Incidents");
  }
  return result("accepted", null);
}

export function selectHumanAuthorizationCommand(
  comments: readonly HumanAuthorizationComment[],
  facts: AuthorizationGuardFacts
): AuthorizationCommandSelection {
  const ordered = [...comments].toSorted((left, right) => left.commentId - right.commentId);
  const evaluations: AuthorizationCommentEvaluation[] = [];
  let winner: { command: HumanAuthorizationCommand; comment: HumanAuthorizationComment } | null = null;
  for (const comment of ordered) {
    if (winner !== null) {
      evaluations.push({ commentId: comment.commentId, status: "ignored", reason: "a lower comment ID already supplied the first valid command" });
      continue;
    }
    const result = evaluateComment(comment, facts);
    evaluations.push(result.evaluation);
    if (result.evaluation.status === "accepted" && result.command !== null) winner = { command: result.command, comment };
  }
  if (winner === null) return { status: "none", evaluations };
  return {
    status: "accepted",
    command: winner.command,
    provenance: {
      issueId: winner.comment.issueId,
      requestCommentId: facts.authorizationRequest.commentId,
      requestCommentUrl: facts.authorizationRequest.url,
      decisionCommentId: winner.comment.commentId,
      decisionCommentUrl: winner.comment.url,
      actorLogin: winner.comment.authorLogin,
      permission: winner.comment.authorPermission,
      createdAt: winner.comment.createdAt,
      bodyDigest: canonicalSha256(winner.comment.body),
      factoryRunId: winner.command.factoryRunId,
      candidateHeadSha: winner.command.kind === "abort" ? null : winner.command.candidateHeadSha
    },
    evaluations
  };
}
