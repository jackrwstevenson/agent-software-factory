import assert from "node:assert/strict";
import { canonicalSha256 } from "../../src/protocol/canonical-json.js";
import test from "node:test";

import {
  parseFactoryRunId,
  parseGitObjectId,
  parseStageAttemptId,
  type CandidateRelease
} from "../../src/protocol/contracts.js";
import type { AcceptedRoleResult, BuilderRoleResult } from "../../src/roles/contracts.js";
import { RoleRuntimeError } from "../../src/roles/errors.js";
import { assertHandoffConsumable, createHandoffManifest } from "../../src/roles/handoffs.js";

function candidate(head: string, tree = "a".repeat(40)): CandidateRelease {
  return {
    schemaVersion: "1.0",
    contract: "candidate_release",
    factoryRunId: parseFactoryRunId("fr_handoff_001"),
    candidateOrdinal: head.startsWith("1") ? 1 : 2,
    builderStageAttemptId: parseStageAttemptId("fa_builder_001"),
    branchRef: "refs/heads/factory/handoff/fr_handoff_001",
    baseSha: parseGitObjectId("0".repeat(40)),
    headCommitSha: parseGitObjectId(head),
    sourceTreeSha: parseGitObjectId(tree)
  };
}

function acceptedBuilder(): AcceptedRoleResult<BuilderRoleResult> {
  const result: BuilderRoleResult = {
    schema_version: "1.0",
    contract: "role_result",
    role: "builder",
    factory_run_id: "fr_handoff_001",
    stage_attempt_id: "fa_builder_001",
    invocation_id: "ri_builder_001",
    input_sha256: "b".repeat(64),
    candidate_head_sha: null,
    decision: "changes_ready",
    summary: "ready",
    evidence_claims: ["fact:source"],
    unresolved_risks: [],
    role_result: {
      changed_paths: ["product.txt"],
      criteria: [{ criterion: "works", status: "addressed", evidence_claims: [] }],
      commands: [],
      demonstration_summary: "works",
      blocker: null
    }
  };
  return {
    schema_version: "1.0",
    contract: "accepted_role_result",
    accepted_at: "2026-09-29T09:00:00.000Z",
    input_sha256: result.input_sha256,
    result_sha256: canonicalSha256(result),
    evidence_digest: "d".repeat(64),
    result,
    postconditions: {
      role: "builder",
      candidate_head_sha: null,
      changed_paths: ["product.txt"],
      git_head_unchanged: true,
      git_refs_unchanged: true,
      git_index_unchanged: true,
      source_tree_unchanged: false,
      forbidden_paths_unchanged: true,
      diff_check_passed: true,
      process_group_absent: true
    },
    process: {
      executable_path: "/pinned/codex",
      executable_sha256: "e".repeat(64),
      version: "codex-cli 0.154.0",
      pid: 100,
      pgid: 100,
      birth_identity: "f".repeat(64),
      started_at: "2026-09-29T08:59:00.000Z",
      completed_at: "2026-09-29T09:00:00.000Z",
      duration_ms: 60_000,
      exit_code: 0,
      signal: null,
      cancellation_reason: null,
      process_group_absent: true,
      events_sha256: "1".repeat(64),
      events_bytes: 10,
      stderr_sha256: "2".repeat(64),
      stderr_bytes: 0
    }
  };
}

test("Handoff Manifests bind kind, source role, downstream, verified result, and full Candidate identity", () => {
  const sourceCandidate = candidate("1".repeat(40));
  const source = acceptedBuilder();
  const first = createHandoffManifest({
    handoffId: "ho_builder_001",
    kind: "builder_to_verifier",
    accepted: source,
    candidate: sourceCandidate,
    createdAt: "2026-09-29T09:01:00.000Z",
    payload: { z: 1, a: "minimum facts" }
  });
  const reordered = createHandoffManifest({
    handoffId: "ho_builder_001",
    kind: "builder_to_verifier",
    accepted: source,
    candidate: sourceCandidate,
    createdAt: "2026-09-29T09:01:00.000Z",
    payload: { a: "minimum facts", z: 1 }
  });

  assert.equal(first.sha256, reordered.sha256);
  assert.equal(first.canonicalJson, reordered.canonicalJson);
  assert.equal(first.manifest.source_role, "builder");
  assert.equal(first.manifest.downstream, "verifier");
  assert.deepEqual(first.manifest.candidate, {
    schema_version: "1.0",
    contract: "candidate_release",
    factory_run_id: sourceCandidate.factoryRunId,
    candidate_ordinal: sourceCandidate.candidateOrdinal,
    builder_stage_attempt_id: sourceCandidate.builderStageAttemptId,
    branch_ref: sourceCandidate.branchRef,
    base_sha: sourceCandidate.baseSha,
    head_commit_sha: sourceCandidate.headCommitSha,
    source_tree_sha: sourceCandidate.sourceTreeSha
  });
  assert.equal(assertHandoffConsumable({
    manifest: first.manifest,
    factoryRunId: sourceCandidate.factoryRunId,
    candidate: sourceCandidate,
    sourceAccepted: source,
    downstream: "verifier"
  }), first.manifest);
});

test("Handoff validation rejects wrong kind/source/downstream, tampered source results, and superseded full Candidate identity", () => {
  const original = candidate("1".repeat(40));
  const source = acceptedBuilder();
  assert.throws(() => createHandoffManifest({
    handoffId: "ho_wrong_kind",
    kind: "verifier_to_reviewer",
    accepted: source,
    candidate: original,
    createdAt: "2026-09-29T09:01:00.000Z",
    payload: {}
  }), (error: unknown) => error instanceof RoleRuntimeError && error.code === "identity_mismatch");

  const handoff = createHandoffManifest({
    handoffId: "ho_builder_002",
    kind: "builder_to_verifier",
    accepted: source,
    candidate: original,
    createdAt: "2026-09-29T09:01:00.000Z",
    payload: {}
  });
  const tamperedSource = {
    ...source,
    result: { ...source.result, summary: "tampered" }
  };
  for (const action of [
    () => assertHandoffConsumable({ manifest: handoff.manifest, factoryRunId: original.factoryRunId, candidate: candidate("1".repeat(40), "b".repeat(40)), sourceAccepted: source, downstream: "verifier" }),
    () => assertHandoffConsumable({ manifest: handoff.manifest, factoryRunId: original.factoryRunId, candidate: original, sourceAccepted: source, downstream: "reviewer" }),
    () => assertHandoffConsumable({ manifest: handoff.manifest, factoryRunId: original.factoryRunId, candidate: original, sourceAccepted: tamperedSource, downstream: "verifier" })
  ]) {
    assert.throws(action, (error: unknown) => error instanceof RoleRuntimeError);
  }
});
