import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHumanAuthorizationCommand,
  selectHumanAuthorizationCommand,
  type AuthorizationGuardFacts,
  type HumanAuthorizationComment
} from "../../src/domain/authorization-policy.js";
import { parseFactoryRunId, parseGitObjectId, parseIssueId } from "../../src/protocol/contracts.js";

const runId = parseFactoryRunId("fr_authorization");
const candidate = parseGitObjectId("1111111111111111111111111111111111111111");
const issueId = parseIssueId("91");

function facts(overrides: Partial<AuthorizationGuardFacts> = {}): AuthorizationGuardFacts {
  return {
    expectedIssueId: issueId,
    expectedFactoryRunId: runId,
    expectedCandidateHeadSha: candidate,
    lifecycleState: "awaiting_human_authorization",
    riskClassification: "elevated",
    allowedLogins: ["GH_ENTERPRISE_USERNAME"],
    minimumPermission: "admin",
    pullRequestHeadSha: candidate,
    authorizationRequest: {
      commentId: 100,
      url: "https://github.org.com/example/issues/91#issuecomment-100",
      createdAt: "2026-09-29T08:00:00.000Z"
    },
    evidenceComplete: true,
    verificationPassed: true,
    reviewComplete: true,
    sourceGuardsPassed: true,
    unresolvedIncidentCount: 0,
    ...overrides
  };
}

function comment(
  commentId: number,
  body: string,
  overrides: Partial<HumanAuthorizationComment> = {}
): HumanAuthorizationComment {
  return {
    issueId,
    commentId,
    url: `https://github.org.com/example/issues/91#issuecomment-${commentId}`,
    authorLogin: "GH_ENTERPRISE_USERNAME",
    authorPermission: "admin",
    createdAt: "2026-09-29T08:01:00.000Z",
    body,
    factoryAuthored: false,
    containsFactoryEventMarker: false,
    ...overrides
  };
}

const approvalBody = `/factory approve ${runId} ${candidate}`;

test("human Authorization commands require exact syntax, issue, run, and full Candidate SHA", () => {
  assert.equal(parseHumanAuthorizationCommand(`/factory approve ${runId} 1111111`), null);
  const selection = selectHumanAuthorizationCommand([comment(101, approvalBody)], facts());
  assert.equal(selection.status, "accepted");
  if (selection.status === "accepted") {
    assert.equal(selection.command.kind, "approve");
    assert.equal(selection.provenance.issueId, issueId);
    assert.equal(selection.provenance.requestCommentId, 100);
    assert.equal(selection.provenance.decisionCommentId, 101);
    assert.equal(selection.provenance.actorLogin, "GH_ENTERPRISE_USERNAME");
    assert.equal(selection.provenance.permission, "admin");
    assert.equal(selection.provenance.factoryRunId, runId);
    assert.equal(selection.provenance.candidateHeadSha, candidate);
    assert.match(selection.provenance.bodyDigest, /^[0-9a-f]{64}$/);
  }
});

test("comment context rejects wrong issue, pre-request commands, factory output, markers, and maintain permission", () => {
  const candidates = [
    comment(101, approvalBody, { issueId: parseIssueId("92") }),
    comment(99, approvalBody, { createdAt: "2026-09-29T07:59:59.000Z" }),
    comment(102, approvalBody, { factoryAuthored: true }),
    comment(103, `${approvalBody}\n<!-- factory:v1 {} -->`, { containsFactoryEventMarker: true }),
    comment(104, approvalBody, { authorPermission: "maintain" })
  ];
  const selection = selectHumanAuthorizationCommand(candidates, facts());
  assert.equal(selection.status, "none");
  assert.deepEqual(selection.evaluations.map((evaluation) => evaluation.status), ["stale", "stale", "ignored", "ignored", "ignored"]);
});

test("the first valid command by increasing comment ID wins and later commands remain evidenced", () => {
  const selection = selectHumanAuthorizationCommand([
    comment(105, `/factory reject ${runId} ${candidate} later rejection`),
    comment(103, approvalBody),
    comment(102, approvalBody, { authorLogin: "NOT-ALLOWED" })
  ], facts());
  assert.equal(selection.status, "accepted");
  if (selection.status === "accepted") {
    assert.equal(selection.provenance.decisionCommentId, 103);
    assert.equal(selection.command.kind, "approve");
  }
  assert.deepEqual(selection.evaluations.map((evaluation) => [evaluation.commentId, evaluation.status]), [
    [102, "ignored"],
    [103, "accepted"],
    [105, "ignored"]
  ]);
});

test("approval cannot waive stale Candidate, Prohibited risk, failed evidence, or Incidents", () => {
  const staleSha = parseGitObjectId("2222222222222222222222222222222222222222");
  assert.equal(selectHumanAuthorizationCommand([comment(101, approvalBody)], facts({ pullRequestHeadSha: staleSha })).status, "none");
  assert.equal(selectHumanAuthorizationCommand([comment(101, approvalBody)], facts({ riskClassification: "prohibited" })).status, "none");
  assert.equal(selectHumanAuthorizationCommand([comment(101, approvalBody)], facts({ verificationPassed: false })).status, "none");
  assert.equal(selectHumanAuthorizationCommand([comment(101, approvalBody)], facts({ unresolvedIncidentCount: 1 })).status, "none");
});

test("exact rejection is valid only during the Elevated wait and abort remains administrative", () => {
  const rejection = comment(101, `/factory reject ${runId} ${candidate} risk is not accepted`);
  assert.equal(selectHumanAuthorizationCommand([rejection], facts()).status, "accepted");
  assert.equal(selectHumanAuthorizationCommand([rejection], facts({ lifecycleState: "authorizing" })).status, "none");
  assert.equal(selectHumanAuthorizationCommand([rejection], facts({ riskClassification: "low" })).status, "none");

  const abort = comment(101, `/factory abort ${runId} stop requested`);
  assert.equal(selectHumanAuthorizationCommand([abort], facts({ lifecycleState: "paused_for_operator" })).status, "accepted");
});
