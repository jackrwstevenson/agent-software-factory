import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFactoryRunCommand,
  type FactoryRunCommand,
  type FactoryRunState
} from "../../src/domain/factory-run.js";
import type { CandidateRelease } from "../../src/protocol/contracts.js";
import { parseDigest, parseFactoryRunId, parseGitObjectId, type Digest, parseIssueId, parseStageAttemptId } from "../../src/protocol/contracts.js";

const digest = (character: string): Digest => parseDigest(character.repeat(64));

function candidate(ordinal: number, character: string): CandidateRelease {
  return {
    schemaVersion: "1.0",
    contract: "candidate_release",
    factoryRunId: parseFactoryRunId("fr_fixture_001"),
    candidateOrdinal: ordinal,
    builderStageAttemptId: parseStageAttemptId(`fa_builder_00${ordinal}`),
    branchRef: "refs/heads/factory/fixture",
    baseSha: parseGitObjectId("0000000000000000000000000000000000000000"),
    headCommitSha: parseGitObjectId(character.repeat(40)),
    sourceTreeSha: parseGitObjectId(String(Number(character) + 1).repeat(40))
  };
}

function apply(state: FactoryRunState | null, command: FactoryRunCommand): FactoryRunState {
  const result = applyFactoryRunCommand(state, command);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.state;
}

test("repair supersedes a Candidate and stale evidence cannot advance its replacement", () => {
  const first = candidate(1, "1");
  const second = candidate(2, "3");
  let state = apply(null, {
    kind: "create_run",
    authority: "orchestrator",
    factoryRunId: first.factoryRunId,
    issueId: parseIssueId("fixture")
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "Candidate 1 ready",
    evidence: { candidate: first, builderEvidenceDigest: digest("a") }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "building",
    reason: "Verifier requested product repair",
    evidence: {
      repair: {
        candidateHeadSha: first.headCommitSha,
        requestedBy: "verifier",
        evidenceDigest: digest("b")
      }
    }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "Candidate 2 ready",
    evidence: { candidate: second, builderEvidenceDigest: digest("c") }
  });

  const staleResult = applyFactoryRunCommand(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "reviewing",
    reason: "stale Verifier output",
    evidence: {
      candidateHeadSha: first.headCommitSha,
      verificationEvidenceDigest: digest("d")
    }
  });

  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) assert.equal(staleResult.error.code, "STALE_CANDIDATE");
});

test("repair cannot register a replacement Candidate that reuses a prior head SHA", () => {
  const first = candidate(1, "1");
  const reusedHead: CandidateRelease = {
    ...candidate(2, "3"),
    headCommitSha: first.headCommitSha
  };
  let state = apply(null, {
    kind: "create_run",
    authority: "orchestrator",
    factoryRunId: first.factoryRunId,
    issueId: parseIssueId("fixture")
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "Candidate 1 ready",
    evidence: { candidate: first, builderEvidenceDigest: digest("a") }
  });
  state = apply(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "building",
    reason: "Verifier requested repair",
    evidence: {
      repair: {
        candidateHeadSha: first.headCommitSha,
        requestedBy: "verifier",
        evidenceDigest: digest("b")
      }
    }
  });

  const result = applyFactoryRunCommand(state, {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "Candidate 2 reused Candidate 1 head",
    evidence: { candidate: reusedHead, builderEvidenceDigest: digest("c") }
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_CANDIDATE");
});
