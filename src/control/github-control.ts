import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readJsonFile, writeDurableJsonFile } from "../journal/durable-json-file.js";
import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  parseGitObjectId,
  parseIssueId,
  type Digest,
  type EffectInvocationContext,
  type FactoryRunId,
  type GitObjectId,
  type IssueId,
  type TerminalOutcome
} from "../protocol/contracts.js";
import { validateProtocol } from "../protocol/schemas.js";
import {
  DEFAULT_GITHUB_CONTROL_CONFIG,
  isActiveOrTerminalFactoryLabel,
  isFactoryLifecycleLabel,
  REQUIRED_FACTORY_LABELS,
  TERMINAL_FACTORY_LABEL_BY_OUTCOME,
  TERMINAL_ROLLOUT_STATUS_BY_OUTCOME
} from "./config.js";
import type {
  ClaimOutcome,
  ClaimPlan,
  ClaimReceipt,
  CommitStatusState,
  FactoryIssue,
  GitHubCommitStatusRecord,
  GitHubControlConfig,
  GitHubPreflightEvidence,
  IssueEventReceipt,
  TerminalProjectionReceipt
} from "./contracts.js";
import { GitHubControlError } from "./errors.js";
import type {
  ClaimIntentStore,
  GitHubApi,
  GitHubCommentRecord,
  GitHubIssueRecord
} from "./github-boundary.js";

export { GitHubControlError } from "./errors.js";
export { DEFAULT_GITHUB_CONTROL_CONFIG, REQUIRED_FACTORY_LABELS } from "./config.js";
export type {
  ClaimOutcome,
  ClaimPlan,
  ClaimReceipt,
  CommitStatusState,
  GitHubCommitStatusRecord,
  GitHubControlConfig,
  GitHubPreflightEvidence,
  IssueEventReceipt
} from "./contracts.js";
export type { GitHubApi, GitHubCommentRecord, GitHubIssueRecord } from "./github-boundary.js";

const FACTORY_MARKER = /^<!-- factory:v1 event_id=([^ ]+) run_id=([^ ]+) event=([^ ]+) /;

interface ClaimIntent {
  readonly schemaVersion: "1.0";
  readonly contract: "factory_claim_intent";
  readonly status: "pending" | "claimed" | "accepted" | "paused";
  readonly effectIntentId: string;
  readonly factoryRunId: FactoryRunId;
  readonly claimEventId: string;
  readonly claimedAt: string;
  readonly issue: GitHubIssueRecord;
  readonly commentBody: string;
  readonly commentBodyDigest: Digest;
  readonly receipt?: ClaimReceipt;
  readonly pauseDetail?: string;
}

export class FileClaimIntentStore implements ClaimIntentStore<ClaimIntent> {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<ClaimIntent | null> {
    const value = await readJsonFile(this.#path);
    if (value === null) return null;
    const validation = validateProtocol<ClaimIntent>("factory-claim-intent", value);
    if (!validation.ok) throw new Error(`claim intent contract violation: ${validation.errors.join("; ")}`);
    return validation.value;
  }

  async save(intent: ClaimIntent): Promise<void> {
    const validation = validateProtocol<ClaimIntent>("factory-claim-intent", intent);
    if (!validation.ok) throw new Error(`claim intent contract violation: ${validation.errors.join("; ")}`);
    await writeDurableJsonFile(this.#path, intent);
  }

  async accept(factoryRunId: FactoryRunId): Promise<void> {
    const intent = await this.load();
    if (intent === null) return;
    if (intent.factoryRunId !== factoryRunId || intent.status !== "claimed" || intent.receipt === undefined) {
      throw new Error(`github_conflict: durable claim cannot be accepted for ${factoryRunId}`);
    }
    const accepted = { ...intent, status: "accepted" as const };
    await this.save(accepted);
    const historyPath = join(dirname(this.#path), "claims", `${factoryRunId}.json`);
    await mkdir(dirname(historyPath), { recursive: true, mode: 0o700 });
    await rename(this.#path, historyPath);
  }
}

function issueForFactory(issue: GitHubIssueRecord): ClaimReceipt["issue"] {
  return {
    issueId: parseIssueId(String(issue.number)),
    number: issue.number,
    title: issue.title,
    acceptanceCriteria: issue.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^- \[[ xX]\] /.test(line))
      .map((line) => line.replace(/^- \[[ xX]\] /, "")),
    url: issue.url,
    createdAt: issue.createdAt
  };
}

function claimComment(plan: ClaimPlan, issue: GitHubIssueRecord, factoryLogin: string): string {
  return [
    `<!-- factory:v1 event_id=${plan.claimEventId} run_id=${plan.context.factoryRunId} event=claim.accepted attempt_id=none candidate_sha=none -->`,
    "",
    `Factory Run \`${plan.context.factoryRunId}\` claimed issue #${issue.number}.`,
    `Factory login: \`${factoryLogin}\``,
    `Claimed at: ${plan.claimedAt}`
  ].join("\n");
}

function sortOldestReady(issues: readonly GitHubIssueRecord[]): GitHubIssueRecord | null {
  const eligible = issues
    .filter((issue) => !issue.pullRequest)
    .filter((issue) => issue.state === "open")
    .filter((issue) => issue.labels.includes("factory:ready"))
    .filter((issue) => !issue.labels.some(isActiveOrTerminalFactoryLabel))
    .filter((issue) => issue.assignees.length === 0)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.number - right.number);
  return eligible[0] ?? null;
}

function claimMarkers(comments: readonly GitHubCommentRecord[]): readonly Readonly<{
  eventId: string;
  runId: string;
  event: string;
  comment: GitHubCommentRecord;
}>[] {
  return comments.flatMap((comment) => {
    const match = FACTORY_MARKER.exec(comment.body.split("\n", 1)[0] ?? "");
    if (match === null) return [];
    const eventId = match[1];
    const runId = match[2];
    const event = match[3];
    if (eventId === undefined || runId === undefined || event === undefined) return [];
    return [{ eventId, runId, event, comment }];
  });
}

function conflict(detail: string): ClaimOutcome {
  return { status: "paused", reason: "github_conflict", detail };
}

export class RecoverableGitHubControl {
  readonly #api: GitHubApi;
  readonly #claimStore: ClaimIntentStore<ClaimIntent>;
  readonly #factoryLogin: string;
  readonly #config: GitHubControlConfig;

  constructor(input: {
    readonly api: GitHubApi;
    readonly claimStore: ClaimIntentStore<ClaimIntent>;
    readonly factoryLogin?: string;
    readonly config?: GitHubControlConfig;
  }) {
    this.#api = input.api;
    this.#claimStore = input.claimStore;
    this.#config = input.config ?? DEFAULT_GITHUB_CONTROL_CONFIG;
    this.#factoryLogin = input.factoryLogin ?? this.#config.factoryLogin;
  }

  async preflight(): Promise<GitHubPreflightEvidence> {
    const observation = await this.#api.preflight();
    if (observation.cliVersion !== this.#config.expectedCliVersion) {
      throw new GitHubControlError(
        "github_blocked_configuration",
        `expected GitHub CLI ${this.#config.expectedCliVersion}, found ${observation.cliVersion}`
      );
    }
    if (!observation.authenticated || observation.login !== this.#config.factoryLogin) {
      throw new GitHubControlError(
        "github_blocked_authentication",
        `GitHub authentication must be active for ${this.#config.factoryLogin}`
      );
    }
    if (
      observation.enterpriseVersion !== this.#config.expectedEnterpriseVersion ||
      observation.repository !== this.#config.repository ||
      observation.defaultBranch !== this.#config.defaultBranch
    ) {
      throw new GitHubControlError(
        "github_blocked_configuration",
        "GitHub Enterprise, repository, or default-branch identity mismatch"
      );
    }
    if (!observation.issuesEnabled || !["maintain", "admin"].includes(observation.permission)) {
      throw new GitHubControlError(
        "github_blocked_capability",
        "repository issues and maintain-or-admin permission are required"
      );
    }
    const labels = new Map(observation.labels.map((label) => [label.name, label]));
    const missingOrMismatched = REQUIRED_FACTORY_LABELS.filter((required) => {
      const actual = labels.get(required.name);
      return (
        actual === undefined ||
        actual.color.toUpperCase() !== required.color ||
        actual.description !== required.description
      );
    });
    if (missingOrMismatched.length > 0 || Object.values(observation.readable).some((readable) => !readable)) {
      throw new GitHubControlError(
        "github_blocked_capability",
        `GitHub capability or label contract is incomplete: ${missingOrMismatched.map((label) => label.name).join(", ")}`
      );
    }
    return {
      ...observation,
      host: this.#config.host,
      restApiVersion: this.#config.restApiVersion
    };
  }

  async claimOldestReady(plan: ClaimPlan): Promise<ClaimOutcome> {
    const existing = await this.#claimStore.load();
    if (existing !== null) return this.#reconcileStored(existing);
    const issue = sortOldestReady(await this.#api.listReadyIssues());
    if (issue === null) return { status: "no_work" };
    const commentBody = claimComment(plan, issue, this.#factoryLogin);
    const intent: ClaimIntent = {
      schemaVersion: "1.0",
      contract: "factory_claim_intent",
      status: "pending",
      effectIntentId: plan.context.effectIntentId,
      factoryRunId: plan.context.factoryRunId,
      claimEventId: plan.claimEventId,
      claimedAt: plan.claimedAt,
      issue,
      commentBody,
      commentBodyDigest: canonicalSha256(commentBody)
    };
    await this.#claimStore.save(intent);
    return this.#reconcileStored(intent);
  }

  async reconcilePendingClaim(): Promise<ClaimOutcome> {
    const intent = await this.#claimStore.load();
    if (intent === null) return { status: "no_work" };
    return this.#reconcileStored(intent);
  }

  async #reconcileStored(intent: ClaimIntent): Promise<ClaimOutcome> {
    if ((intent.status === "claimed" || intent.status === "accepted") && intent.receipt !== undefined) {
      return { status: "claimed", claim: intent.receipt };
    }
    if (intent.status === "paused") {
      return conflict(intent.pauseDetail ?? "the durable claim is paused");
    }
    const outcome = await this.#reconcile(intent);
    if (outcome.status === "paused") {
      await this.#claimStore.save({ ...intent, status: "paused", pauseDetail: outcome.detail });
    } else if (outcome.status === "claimed") {
      await this.#claimStore.save({ ...intent, status: "claimed", receipt: outcome.claim });
    }
    return outcome;
  }

  async acceptClaim(factoryRunId: FactoryRunId): Promise<void> {
    await this.#claimStore.accept(factoryRunId);
  }

  async loadIssue(issueId: IssueId): Promise<FactoryIssue> {
    const issueNumber = Number.parseInt(issueId, 10);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new GitHubControlError("github_conflict", `issue ID is not a GitHub issue number: ${issueId}`);
    }
    return issueForFactory(await this.#api.getIssue(issueNumber));
  }

  async publishIssueEvent(input: {
    readonly invocation: EffectInvocationContext;
    readonly issueNumber: number;
    readonly eventId: string;
    readonly event: string;
    readonly candidateSha: GitObjectId | null;
    readonly body: string;
  }): Promise<IssueEventReceipt> {
    if (!/^fe_[a-z0-9][a-z0-9_-]{2,63}$/.test(input.eventId)) {
      throw new TypeError(`invalid GitHub projection event ID: ${input.eventId}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.event)) {
      throw new TypeError(`invalid GitHub projection event token: ${input.event}`);
    }
    if (input.candidateSha !== null) parseGitObjectId(input.candidateSha);
    const marker = `<!-- factory:v1 event_id=${input.eventId} run_id=${input.invocation.factoryRunId} event=${input.event} attempt_id=none candidate_sha=${input.candidateSha ?? "none"} -->`;
    const body = `${marker}\n\n${input.body}`;
    const bodyDigest = canonicalSha256(body);
    const comments = await this.#api.listIssueComments(input.issueNumber);
    const sameEventId = claimMarkers(comments).filter((candidate) => candidate.eventId === input.eventId);
    if (sameEventId.length > 1) {
      throw new GitHubControlError("github_conflict", `duplicate projection event ${input.eventId}`);
    }
    const existing = sameEventId[0];
    if (existing !== undefined) {
      if (existing.runId !== input.invocation.factoryRunId || canonicalSha256(existing.comment.body) !== bodyDigest) {
        throw new GitHubControlError("github_conflict", `mismatched projection event ${input.eventId}`);
      }
      return { eventId: input.eventId, commentId: existing.comment.id, commentUrl: existing.comment.url, bodyDigest };
    }
    const created = await this.#api.createIssueComment({ issueNumber: input.issueNumber, body });
    const verified = (await this.#api.listIssueComments(input.issueNumber)).filter((comment) => {
      const parsed = claimMarkers([comment])[0];
      return parsed?.eventId === input.eventId && parsed.runId === input.invocation.factoryRunId && canonicalSha256(comment.body) === bodyDigest;
    });
    if (verified.length !== 1 || verified[0] === undefined) {
      throw new GitHubControlError("github_conflict", `projection event ${input.eventId} did not verify exactly once`);
    }
    return { eventId: input.eventId, commentId: created.id, commentUrl: created.url, bodyDigest };
  }

  async publishCommitStatus(input: {
    readonly invocation: EffectInvocationContext;
    readonly candidateSha: GitObjectId;
    readonly context: string;
    readonly state: CommitStatusState;
    readonly description: string;
    readonly targetUrl: string;
  }): Promise<GitHubCommitStatusRecord> {
    parseGitObjectId(input.candidateSha);
    const existing = (await this.#api.listCommitStatuses(input.candidateSha)).filter(
      (status) =>
        status.candidateSha === input.candidateSha &&
        status.context === input.context &&
        status.state === input.state &&
        status.description === input.description &&
        status.targetUrl === input.targetUrl
    );
    if (existing.length > 1) {
      throw new GitHubControlError("github_conflict", `duplicate exact statuses for ${input.candidateSha}`);
    }
    if (existing[0] !== undefined) return existing[0];
    const created = await this.#api.createCommitStatus(input);
    if (
      created.candidateSha !== input.candidateSha ||
      created.context !== input.context ||
      created.state !== input.state ||
      created.description !== input.description ||
      created.targetUrl !== input.targetUrl
    ) {
      throw new GitHubControlError("github_conflict", "GitHub returned a mismatched Candidate status");
    }
    return created;
  }

  async projectTerminal(input: {
    readonly invocation: EffectInvocationContext;
    readonly issueNumber: number;
    readonly terminalOutcome: TerminalOutcome;
    readonly candidateSha: GitObjectId | null;
    readonly branchRef: string | null;
  }): Promise<TerminalProjectionReceipt> {
    if (input.candidateSha !== null) parseGitObjectId(input.candidateSha);
    let issue = await this.#api.getIssue(input.issueNumber);
    const unexpectedAssignees = issue.assignees.filter((login) => login !== this.#factoryLogin);
    if (unexpectedAssignees.length > 0) {
      throw new GitHubControlError(
        "github_conflict",
        `terminal projection found unexpected assignee ${unexpectedAssignees.join(", ")}`
      );
    }
    const eventId = `fe_${input.invocation.effectIntentId.slice("fx_".length)}`;
    const body = [
      `Factory Run: \`${input.invocation.factoryRunId}\``,
      `Terminal Outcome: \`${input.terminalOutcome}\``,
      `Candidate SHA: \`${input.candidateSha ?? "none"}\``,
      `Factory Branch: \`${input.branchRef ?? "none"}\``
    ].join("\n");
    const existingTerminal = claimMarkers(await this.#api.listIssueComments(input.issueNumber)).filter(
      (marker) => marker.runId === input.invocation.factoryRunId && marker.event === "run.terminal"
    );
    if (existingTerminal.length > 1 || (existingTerminal[0] !== undefined && existingTerminal[0].eventId !== eventId)) {
      throw new GitHubControlError(
        "github_conflict",
        `Factory Run ${input.invocation.factoryRunId} has a conflicting terminal projection`
      );
    }
    const comment = await this.publishIssueEvent({
      invocation: input.invocation,
      issueNumber: input.issueNumber,
      eventId,
      event: "run.terminal",
      candidateSha: input.candidateSha,
      body
    });
    const rolloutProjection = TERMINAL_ROLLOUT_STATUS_BY_OUTCOME[input.terminalOutcome];
    const rolloutStatus = input.candidateSha === null || rolloutProjection === null
      ? null
      : await this.publishCommitStatus({
          invocation: input.invocation,
          candidateSha: input.candidateSha,
          context: "factory/rollout",
          state: rolloutProjection.state,
          description: rolloutProjection.description,
          targetUrl: comment.commentUrl
        });
    const terminalLabel = TERMINAL_FACTORY_LABEL_BY_OUTCOME[input.terminalOutcome];
    const issueState = input.terminalOutcome === "succeeded" ? "closed" : "open";
    const expectedLabels = issue.labels
      .filter((label) => !isFactoryLifecycleLabel(label))
      .concat(terminalLabel);
    const lifecycleLabels = issue.labels.filter(isFactoryLifecycleLabel);
    if (
      issue.state !== issueState ||
      lifecycleLabels.length !== 1 ||
      lifecycleLabels[0] !== terminalLabel
    ) {
      issue = await this.#api.updateIssueProjection({
        issueNumber: input.issueNumber,
        labels: expectedLabels,
        assignees: issue.assignees,
        state: issueState
      });
    }

    const verified = await this.#api.getIssue(input.issueNumber);
    const verifiedLabels = verified.labels.filter(isFactoryLifecycleLabel);
    const verifiedUnexpectedAssignees = verified.assignees.filter((login) => login !== this.#factoryLogin);
    const verifiedTerminal = claimMarkers(await this.#api.listIssueComments(input.issueNumber)).filter(
      (marker) =>
        marker.runId === input.invocation.factoryRunId &&
        marker.event === "run.terminal" &&
        marker.eventId === eventId &&
        canonicalSha256(marker.comment.body) === comment.bodyDigest
    );
    const expectedSorted = [...expectedLabels].sort();
    const actualSorted = [...verified.labels].sort();
    if (
      verified.state !== issueState ||
      verifiedUnexpectedAssignees.length > 0 ||
      verifiedLabels.length !== 1 ||
      verifiedLabels[0] !== terminalLabel ||
      expectedSorted.length !== actualSorted.length ||
      expectedSorted.some((label, index) => label !== actualSorted[index]) ||
      verifiedTerminal.length !== 1
    ) {
      throw new GitHubControlError(
        "github_conflict",
        `terminal projection verification failed for issue #${input.issueNumber}`
      );
    }
    return { terminalOutcome: input.terminalOutcome, terminalLabel, issueState, comment, rolloutStatus };
  }

  async #reconcile(intent: ClaimIntent): Promise<ClaimOutcome> {
    let issue = await this.#api.getIssue(intent.issue.number);
    const comments = await this.#api.listIssueComments(intent.issue.number);
    const markers = claimMarkers(comments).filter((marker) => marker.event === "claim.accepted");
    const foreignMarker = markers.find(
      (marker) => marker.eventId !== intent.claimEventId || marker.runId !== intent.factoryRunId
    );
    if (foreignMarker !== undefined) {
      return conflict(`issue #${issue.number} contains a claim marker for another run`);
    }
    const matching = markers.filter(
      (marker) => marker.eventId === intent.claimEventId && marker.runId === intent.factoryRunId
    );
    if (matching.length > 1) {
      return conflict(`issue #${issue.number} contains duplicate claim markers`);
    }
    if (matching[0] !== undefined && canonicalSha256(matching[0].comment.body) !== intent.commentBodyDigest) {
      return conflict(`issue #${issue.number} contains a mismatched duplicate claim marker`);
    }
    if (issue.state !== "open") return conflict(`issue #${issue.number} closed during claim`);

    const unexpectedAssignees = issue.assignees.filter((login) => login !== this.#factoryLogin);
    const conflictingLabels = issue.labels.filter(
      (label) => isActiveOrTerminalFactoryLabel(label) && label !== "factory:running"
    );
    if (unexpectedAssignees.length > 0 || conflictingLabels.length > 0) {
      return conflict(`issue #${issue.number} has conflicting assignee or lifecycle labels`);
    }

    const issueMutationComplete =
      !issue.labels.includes("factory:ready") &&
      issue.labels.includes("factory:running") &&
      issue.assignees.includes(this.#factoryLogin);
    const expectedMutationVisible =
      issue.labels.includes("factory:running") ||
      issue.assignees.includes(this.#factoryLogin) ||
      matching.length === 1;
    if (!issueMutationComplete && !issue.labels.includes("factory:ready") && !expectedMutationVisible) {
      return conflict(`issue #${issue.number} is no longer labelled factory:ready`);
    }
    if (!issueMutationComplete) {
      const labels = issue.labels
        .filter((label) => label !== "factory:ready" && label !== "factory:running")
        .concat("factory:running");
      issue = await this.#api.updateIssueClaim({
        issueNumber: issue.number,
        labels,
        assignees: [this.#factoryLogin]
      });
    }

    let comment = matching[0]?.comment;
    if (comment === undefined) {
      comment = await this.#api.createIssueComment({
        issueNumber: issue.number,
        body: intent.commentBody
      });
    }

    const verifiedIssue = await this.#api.getIssue(issue.number);
    const verifiedComments = await this.#api.listIssueComments(issue.number);
    const verifiedMatches = claimMarkers(verifiedComments).filter(
      (marker) =>
        marker.event === "claim.accepted" &&
        marker.eventId === intent.claimEventId &&
        marker.runId === intent.factoryRunId &&
        canonicalSha256(marker.comment.body) === intent.commentBodyDigest
    );
    if (
      verifiedIssue.state !== "open" ||
      verifiedIssue.labels.includes("factory:ready") ||
      !verifiedIssue.labels.includes("factory:running") ||
      !verifiedIssue.assignees.includes(this.#factoryLogin) ||
      verifiedMatches.length !== 1
    ) {
      return conflict(`claim verification failed for issue #${issue.number}`);
    }

    return {
      status: "claimed",
      claim: {
        factoryRunId: intent.factoryRunId,
        issue: issueForFactory(verifiedIssue),
        commentId: comment.id,
        commentUrl: comment.url,
        verifiedAt: intent.claimedAt
      }
    };
  }
}
