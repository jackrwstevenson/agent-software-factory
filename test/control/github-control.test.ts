import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileClaimIntentStore,
  REQUIRED_FACTORY_LABELS,
  RecoverableGitHubControl,
  type GitHubApi,
  type GitHubCommentRecord,
  type GitHubIssueRecord
} from "../../src/control/github-control.js";
import {
  parseEffectIntentId,
  parseFactoryRunId,
  parseGitObjectId,
  type GitObjectId
} from "../../src/protocol/contracts.js";
import type { GitHubCommitStatusRecord } from "../../src/control/contracts.js";

class CrashableGitHubApi implements GitHubApi {
  readonly issue: GitHubIssueRecord = {
    number: 41,
    title: "Oldest ready issue",
    body: "- [ ] preserve the primary checkout",
    createdAt: "2026-09-28T08:00:00.000Z",
    updatedAt: "2026-09-28T08:00:00.000Z",
    state: "open",
    url: "https://github.org.com/engineering/agentic-software-factory/issues/41",
    labels: ["factory:ready"],
    assignees: []
  };
  readonly comments: GitHubCommentRecord[] = [];
  readonly statuses: GitHubCommitStatusRecord[] = [];
  readonly additionalIssues: GitHubIssueRecord[] = [];
  updateCount = 0;
  projectionCount = 0;
  commentCount = 0;
  statusCount = 0;
  lastStatusSha: GitObjectId | null = null;
  crashAfterUpdate = true;
  crashAfterComment = false;
  withdrawReadyOnRead = false;
  authenticated = true;
  readyListCount = 0;

  async preflight() {
    return {
      cliVersion: "2.96.0",
      authenticated: this.authenticated,
      login: this.authenticated ? "GH_ENTERPRISE_USERNAME" : null,
      enterpriseVersion: "3.19.10",
      repository: "engineering/agentic-software-factory",
      defaultBranch: "main",
      issuesEnabled: true,
      permission: "admin" as const,
      labels: REQUIRED_FACTORY_LABELS,
      linkedBranchCapability: "supported" as const,
      linkedBranchCapabilityEvidence: "fixture capability probe",
      readable: {
        issues: true,
        comments: true,
        pullRequests: true,
        defaultBranchCommit: true,
        commitStatuses: true
      }
    };
  }

  async listReadyIssues(): Promise<readonly GitHubIssueRecord[]> {
    this.readyListCount += 1;
    return [this.issue, ...this.additionalIssues].map((issue) => structuredClone(issue));
  }

  async getIssue(issueNumber: number): Promise<GitHubIssueRecord> {
    const issue = [this.issue, ...this.additionalIssues].find((candidate) => candidate.number === issueNumber);
    if (issue === undefined) throw new Error(`missing issue ${issueNumber}`);
    if (this.withdrawReadyOnRead) {
      this.withdrawReadyOnRead = false;
      issue.labels = issue.labels.filter((label) => label !== "factory:ready");
    }
    return structuredClone(issue);
  }

  async listIssueComments(): Promise<readonly GitHubCommentRecord[]> {
    return structuredClone(this.comments);
  }

  async updateIssueClaim(input: {
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
  }): Promise<GitHubIssueRecord> {
    this.updateCount += 1;
    const issue = [this.issue, ...this.additionalIssues].find((candidate) => candidate.number === input.issueNumber);
    if (issue === undefined) throw new Error(`missing issue ${input.issueNumber}`);
    issue.labels = [...input.labels];
    issue.assignees = [...input.assignees];
    issue.updatedAt = "2026-09-28T09:00:00.000Z";
    if (this.crashAfterUpdate) {
      this.crashAfterUpdate = false;
      throw new Error("injected crash after issue mutation");
    }
    return structuredClone(issue);
  }

  async updateIssueProjection(input: {
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly state: "open" | "closed";
  }): Promise<GitHubIssueRecord> {
    this.projectionCount += 1;
    const issue = [this.issue, ...this.additionalIssues].find((candidate) => candidate.number === input.issueNumber);
    if (issue === undefined) throw new Error(`missing issue ${input.issueNumber}`);
    issue.labels = [...input.labels];
    issue.assignees = [...input.assignees];
    issue.state = input.state;
    issue.updatedAt = "2026-09-29T09:00:00.000Z";
    return structuredClone(issue);
  }

  async createIssueComment(input: { readonly body: string }): Promise<GitHubCommentRecord> {
    this.commentCount += 1;
    const comment = {
      id: 9000 + this.commentCount,
      body: input.body,
      url: `https://github.org.com/comment/${9000 + this.commentCount}`
    };
    this.comments.push(comment);
    if (this.crashAfterComment) {
      this.crashAfterComment = false;
      throw new Error("injected crash after comment mutation");
    }
    return comment;
  }

  async listCommitStatuses(candidateSha: GitObjectId): Promise<readonly GitHubCommitStatusRecord[]> {
    return this.statuses.filter((status) => status.candidateSha === candidateSha);
  }

  async createCommitStatus(input: {
    readonly candidateSha: GitObjectId;
    readonly context: string;
    readonly state: "pending" | "success" | "failure" | "error";
    readonly description: string;
    readonly targetUrl: string;
  }) {
    this.statusCount += 1;
    this.lastStatusSha = input.candidateSha;
    const status = {
      id: 7000 + this.statusCount,
      candidateSha: input.candidateSha,
      context: input.context,
      state: input.state,
      description: input.description,
      targetUrl: input.targetUrl,
      url: `https://github.org.com/status/${7000 + this.statusCount}`
    };
    this.statuses.push(status);
    return status;
  }
}

test("terminal projection publishes one structured comment and adopts exact succeeded issue state", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-terminal-projection-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.issue.labels = ["bug", "factory:running", "factory:needs-approval", "factory:failed"];
    api.issue.assignees = ["GH_ENTERPRISE_USERNAME"];
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim.json"))
    });
    const input = {
      invocation: {
        effectIntentId: parseEffectIntentId("fx_terminal_001"),
        factoryRunId: parseFactoryRunId("fr_terminal_001")
      },
      issueNumber: 41,
      terminalOutcome: "succeeded" as const,
      candidateSha: parseGitObjectId("1234567890abcdef1234567890abcdef12345678"),
      branchRef: "refs/heads/factory/issue-41/fr_terminal_001"
    };

    const first = await control.projectTerminal(input);
    const adopted = await control.projectTerminal(input);

    assert.deepEqual(adopted, first);
    assert.equal(api.commentCount, 1);
    assert.equal(api.projectionCount, 1);
    assert.equal(api.statusCount, 1);
    assert.equal(api.issue.state, "closed");
    assert.deepEqual(api.issue.labels, ["bug", "factory:succeeded"]);
    assert.match(api.comments[0]?.body ?? "", /event=run\.terminal/);
    assert.match(api.comments[0]?.body ?? "", /Terminal Outcome: `succeeded`/);
    assert.match(api.comments[0]?.body ?? "", /Candidate SHA: `1234567890abcdef1234567890abcdef12345678`/);
    assert.deepEqual(first.rolloutStatus, {
      id: 7001,
      candidateSha: "1234567890abcdef1234567890abcdef12345678",
      context: "factory/rollout",
      state: "success",
      description: "Factory Run Succeeded",
      targetUrl: "https://github.org.com/comment/9001",
      url: "https://github.org.com/status/7001"
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("terminal rollout status uses the spec state on the exact Candidate SHA", async () => {
  const cases = [
    ["rolled_back", "failure", "Factory Run Rolled Back"],
    ["failed", "error", "Factory Run Failed"],
    ["aborted", "error", "Factory Run Aborted"]
  ] as const;
  const candidateSha = parseGitObjectId("abcdef1234567890abcdef1234567890abcdef12");

  for (const [terminalOutcome, state, description] of cases) {
    const stateRoot = await mkdtemp(join(tmpdir(), `factory-rollout-status-${terminalOutcome}-`));
    try {
      const api = new CrashableGitHubApi();
      api.crashAfterUpdate = false;
      api.issue.labels = ["factory:running"];
      api.issue.assignees = ["GH_ENTERPRISE_USERNAME"];
      const control = new RecoverableGitHubControl({
        api,
        claimStore: new FileClaimIntentStore(join(stateRoot, "claim.json"))
      });
      const input = {
        invocation: {
          effectIntentId: parseEffectIntentId(`fx_rollout_status_${terminalOutcome}`),
          factoryRunId: parseFactoryRunId(`fr_rollout_status_${terminalOutcome}`)
        },
        issueNumber: 41,
        terminalOutcome,
        candidateSha,
        branchRef: `refs/heads/factory/issue-41/fr_rollout_status_${terminalOutcome}`
      };

      const first = await control.projectTerminal(input);
      const adopted = await control.projectTerminal(input);

      assert.deepEqual(adopted, first);
      assert.equal(api.statusCount, 1);
      assert.deepEqual(api.statuses[0], {
        id: 7001,
        candidateSha,
        context: "factory/rollout",
        state,
        description,
        targetUrl: "https://github.org.com/comment/9001",
        url: "https://github.org.com/status/7001"
      });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
});

test("a rejected Candidate does not fabricate a factory rollout status", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-rejected-no-rollout-status-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.issue.labels = ["factory:running"];
    api.issue.assignees = ["GH_ENTERPRISE_USERNAME"];
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim.json"))
    });

    const receipt = await control.projectTerminal({
      invocation: {
        effectIntentId: parseEffectIntentId("fx_rejected_no_rollout_status"),
        factoryRunId: parseFactoryRunId("fr_rejected_no_rollout_status")
      },
      issueNumber: 41,
      terminalOutcome: "rejected",
      candidateSha: parseGitObjectId("abcdef1234567890abcdef1234567890abcdef12"),
      branchRef: "refs/heads/factory/issue-41/fr_rejected_no_rollout_status"
    });

    assert.equal(receipt.rolloutStatus, null);
    assert.equal(api.statusCount, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("terminal projection rejects an unexpected assignee before publishing", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-terminal-assignee-conflict-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.issue.labels = ["factory:running"];
    api.issue.assignees = ["GH_ENTERPRISE_USERNAME", "unexpected-human"];
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim.json"))
    });

    await assert.rejects(
      control.projectTerminal({
        invocation: {
          effectIntentId: parseEffectIntentId("fx_terminal_assignee_conflict"),
          factoryRunId: parseFactoryRunId("fr_terminal_assignee_conflict")
        },
        issueNumber: 41,
        terminalOutcome: "failed",
        candidateSha: null,
        branchRef: null
      }),
      /unexpected assignee/
    );

    assert.equal(api.commentCount, 0);
    assert.equal(api.statusCount, 0);
    assert.equal(api.projectionCount, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("non-success terminal projections remain open with exactly their terminal label", async () => {
  const cases = [
    ["rejected", "factory:rejected"],
    ["failed", "factory:failed"],
    ["rolled_back", "factory:rolled-back"],
    ["aborted", "factory:aborted"]
  ] as const;

  for (const [terminalOutcome, terminalLabel] of cases) {
    const stateRoot = await mkdtemp(join(tmpdir(), `factory-terminal-${terminalOutcome}-`));
    try {
      const api = new CrashableGitHubApi();
      api.crashAfterUpdate = false;
      api.issue.labels = ["maintenance", "factory:ready", "factory:running", "factory:paused", "factory:succeeded"];
      const control = new RecoverableGitHubControl({
        api,
        claimStore: new FileClaimIntentStore(join(stateRoot, "claim.json"))
      });

      await control.projectTerminal({
        invocation: {
          effectIntentId: parseEffectIntentId(`fx_terminal_${terminalOutcome}`),
          factoryRunId: parseFactoryRunId(`fr_terminal_${terminalOutcome}`)
        },
        issueNumber: 41,
        terminalOutcome,
        candidateSha: null,
        branchRef: null
      });

      assert.equal(api.issue.state, "open");
      assert.deepEqual(api.issue.labels, ["maintenance", terminalLabel]);
      assert.equal(api.comments.filter((comment) => comment.body.includes("event=run.terminal")).length, 1);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
});

test("terminal projection adopts a comment created before a crash without duplicating mutations", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-terminal-crash-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.crashAfterComment = true;
    api.issue.labels = ["factory:running"];
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim.json"))
    });
    const input = {
      invocation: {
        effectIntentId: parseEffectIntentId("fx_terminal_crash"),
        factoryRunId: parseFactoryRunId("fr_terminal_crash")
      },
      issueNumber: 41,
      terminalOutcome: "failed" as const,
      candidateSha: null,
      branchRef: "refs/heads/factory/issue-41/fr_terminal_crash"
    };

    await assert.rejects(control.projectTerminal(input), /injected crash after comment mutation/);
    await control.projectTerminal(input);

    assert.equal(api.commentCount, 1);
    assert.equal(api.projectionCount, 1);
    assert.equal(api.issue.state, "open");
    assert.deepEqual(api.issue.labels, ["factory:failed"]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

const plan = {
  context: {
    effectIntentId: parseEffectIntentId("fx_claim_001"),
    factoryRunId: parseFactoryRunId("fr_claim_001")
  },
  claimEventId: "fe_claim_001",
  claimedAt: "2026-09-28T09:00:00.000Z"
} as const;

test("a crash after the issue mutation reconciles one durable claim", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-claim-"));
  try {
    const api = new CrashableGitHubApi();
    const store = new FileClaimIntentStore(join(stateRoot, "claim-intent.json"));
    const first = new RecoverableGitHubControl({ api, claimStore: store, factoryLogin: "GH_ENTERPRISE_USERNAME" });

    await assert.rejects(first.claimOldestReady(plan), /injected crash/);

    const restarted = new RecoverableGitHubControl({ api, claimStore: store, factoryLogin: "GH_ENTERPRISE_USERNAME" });
    const outcome = await restarted.reconcilePendingClaim();

    assert.equal(outcome.status, "claimed");
    if (outcome.status !== "claimed") return;
    assert.equal(outcome.claim.issue.number, 41);
    assert.equal(outcome.claim.factoryRunId, "fr_claim_001");
    assert.equal(api.updateCount, 1);
    assert.equal(api.commentCount, 1);
    assert.deepEqual(api.issue.labels, ["factory:running"]);
    assert.deepEqual(api.issue.assignees, ["GH_ENTERPRISE_USERNAME"]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("a crash after the claim comment reconciles without a duplicate comment", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-claim-comment-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.crashAfterComment = true;
    const store = new FileClaimIntentStore(join(stateRoot, "claim-intent.json"));
    const control = new RecoverableGitHubControl({ api, claimStore: store, factoryLogin: "GH_ENTERPRISE_USERNAME" });

    await assert.rejects(control.claimOldestReady(plan), /injected crash after comment/);
    const outcome = await new RecoverableGitHubControl({
      api,
      claimStore: store,
      factoryLogin: "GH_ENTERPRISE_USERNAME"
    }).reconcilePendingClaim();

    assert.equal(outcome.status, "claimed");
    assert.equal(api.updateCount, 1);
    assert.equal(api.commentCount, 1);
    assert.equal(api.comments.length, 1);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a conflicting Factory Run marker pauses the claim rather than guessing", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-claim-conflict-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.comments.push({
      id: 88,
      url: "https://github.org.com/comment/88",
      body: "<!-- factory:v1 event_id=fe_other_001 run_id=fr_other_001 event=claim.accepted attempt_id=none candidate_sha=none -->\n\nOther claim"
    });
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim-intent.json")),
      factoryLogin: "GH_ENTERPRISE_USERNAME"
    });

    const outcome = await control.claimOldestReady(plan);

    assert.deepEqual(outcome, {
      status: "paused",
      reason: "github_conflict",
      detail: "issue #41 contains a claim marker for another run"
    });
    assert.equal(api.updateCount, 0);
    assert.equal(api.commentCount, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("commit status reads and writes require the full Candidate SHA", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-status-"));
  try {
    const api = new CrashableGitHubApi();
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim-intent.json")),
      factoryLogin: "GH_ENTERPRISE_USERNAME"
    });

    await assert.rejects(
      control.publishCommitStatus({
        invocation: plan.context,
        candidateSha: "1234567" as GitObjectId,
        context: "factory/verifier",
        state: "success",
        description: "Exact Candidate passed",
        targetUrl: "https://github.org.com/comment/9001"
      }),
      /invalid Git object ID/
    );
    assert.equal(api.statusCount, 0);

    const fullSha = parseGitObjectId("1234567890abcdef1234567890abcdef12345678");
    const status = await control.publishCommitStatus({
      invocation: plan.context,
      candidateSha: fullSha,
      context: "factory/verifier",
      state: "success",
      description: "Exact Candidate passed",
      targetUrl: "https://github.org.com/comment/9001"
    });
    assert.equal(status.candidateSha, fullSha);
    assert.equal(api.lastStatusSha, fullSha);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("startup preflight blocks unauthenticated GitHub before intake polling", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-preflight-auth-"));
  try {
    const api = new CrashableGitHubApi();
    api.authenticated = false;
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim-intent.json")),
      factoryLogin: "GH_ENTERPRISE_USERNAME"
    });

    await assert.rejects(
      control.preflight(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "github_blocked_authentication"
    );
    assert.equal(api.readyListCount, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("oldest-ready selection breaks equal creation times by lowest issue number", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-oldest-ready-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.issue.createdAt = "2026-09-28T10:00:00.000Z";
    api.additionalIssues.push(
      {
        ...structuredClone(api.issue),
        number: 22,
        createdAt: "2026-09-28T07:00:00.000Z",
        url: "https://github.org.com/issues/22"
      },
      {
        ...structuredClone(api.issue),
        number: 21,
        createdAt: "2026-09-28T07:00:00.000Z",
        url: "https://github.org.com/issues/21"
      }
    );
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim-intent.json")),
      factoryLogin: "GH_ENTERPRISE_USERNAME"
    });

    const outcome = await control.claimOldestReady(plan);

    assert.equal(outcome.status, "claimed");
    if (outcome.status === "claimed") assert.equal(outcome.claim.issue.number, 21);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});


test("an issue withdrawn after selection pauses without claiming it", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-withdrawn-ready-"));
  try {
    const api = new CrashableGitHubApi();
    api.crashAfterUpdate = false;
    api.withdrawReadyOnRead = true;
    const control = new RecoverableGitHubControl({
      api,
      claimStore: new FileClaimIntentStore(join(stateRoot, "claim-intent.json")),
      factoryLogin: "GH_ENTERPRISE_USERNAME"
    });

    const outcome = await control.claimOldestReady(plan);

    assert.deepEqual(outcome, {
      status: "paused",
      reason: "github_conflict",
      detail: "issue #41 is no longer labelled factory:ready"
    });
    assert.equal(api.updateCount, 0);
    assert.equal(api.commentCount, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
