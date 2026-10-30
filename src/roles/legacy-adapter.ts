import { join } from "node:path";

import type { FactoryIssue, PreparedSource } from "../control/ports.js";
import {
  parseStageAttemptId,
  type CandidateRelease,
  type EffectInvocationContext
} from "../protocol/contracts.js";
import { candidateDiffFacts } from "./git-inspection.js";
import { createHandoffManifest } from "./handoffs.js";
import type { BuilderResult, ReviewerResult, RoleRuntime, VerifierResult } from "./port.js";
import { rolePolicy } from "./role-policy.js";
import {
  FactoryRoleRuntimeCore,
  type FactoryRoleRuntimeCoreConfig
} from "./role-runtime-core.js";
import type { HandoffManifest, RoleInputIssue } from "./contracts.js";

function issueInput(issue: FactoryIssue): RoleInputIssue {
  return {
    issue_id: issue.issueId,
    number: issue.number,
    title: issue.title,
    acceptance_criteria: issue.acceptanceCriteria,
    url: issue.url,
    created_at: issue.createdAt
  };
}

function idsFromEffectIntent(effectIntentId: string) {
  const suffix = effectIntentId.startsWith("fx_") ? effectIntentId.slice(3) : effectIntentId;
  return { stageAttemptId: parseStageAttemptId(`fa_${suffix}`), invocationId: `ri_${suffix}` };
}

function handoffId(kind: HandoffManifest["kind"], sourceResultSha256: string): string {
  return `ho_${kind.split("_").slice(0, 2).join("_")}_${sourceResultSha256.slice(0, 16)}`;
}

export class LegacyRoleRuntimeAdapter implements RoleRuntime {
  readonly core: FactoryRoleRuntimeCore;

  constructor(config: FactoryRoleRuntimeCoreConfig) {
    this.core = new FactoryRoleRuntimeCore(config);
  }

  preflight() { return this.core.preflight(); }
  reconcilePendingAttempts() { return this.core.reconcilePendingAttempts(); }
  runRole<R extends Parameters<FactoryRoleRuntimeCore["runRole"]>[0]["role"]>(
    request: Parameters<FactoryRoleRuntimeCore["runRole"]>[0] & { role: R }
  ) { return this.core.runRole(request as never); }

  async runBuilder(input: Readonly<{
    context: EffectInvocationContext;
    issue: FactoryIssue;
    preparedSource: PreparedSource;
  }>): Promise<BuilderResult> {
    const ids = idsFromEffectIntent(input.context.effectIntentId);
    const settings = this.core.settings();
    const accepted = await this.core.runRole({
      role: "builder",
      factoryRunId: input.context.factoryRunId,
      stageAttemptId: ids.stageAttemptId,
      invocationId: ids.invocationId,
      lifecycleState: "building",
      stageAttemptOrdinal: 1,
      issue: issueInput(input.issue),
      worktreePath: input.preparedSource.worktreePath,
      branchRef: input.preparedSource.branchRef,
      baseSha: input.preparedSource.baseSha,
      candidate: null,
      instructions: ["Implement the immutable issue within the allowed product paths."],
      policyRefs: [],
      priorHandoffs: [],
      rolePayload: {
        allowed_paths: settings.builderAllowedPaths,
        forbidden_paths: settings.builderForbiddenPaths,
        validation_commands: settings.validationCommands,
        repair_brief: null
      }
    });
    return rolePolicy("builder").adaptLegacyResult(accepted);
  }

  async runVerifier(input: Readonly<{
    context: EffectInvocationContext;
    issue: FactoryIssue;
    candidate: CandidateRelease;
  }>): Promise<VerifierResult> {
    const ids = idsFromEffectIntent(input.context.effectIntentId);
    const settings = this.core.settings();
    const worktreePath = join(settings.stateRoot, "runs", input.candidate.factoryRunId, "worktree");
    const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: settings.stateRoot, TMPDIR: settings.stateRoot, LANG: "C", LC_ALL: "C", TZ: "UTC" };
    const diff = await candidateDiffFacts({ worktreePath, baseSha: input.candidate.baseSha, headSha: input.candidate.headCommitSha, environment });
    const builderAccepted = await this.core.artifacts.findLatestAccepted(input.candidate.factoryRunId, "builder");
    const builderHandoff = createHandoffManifest({
      handoffId: handoffId("builder_to_verifier", builderAccepted.result_sha256),
      kind: "builder_to_verifier",
      accepted: builderAccepted,
      candidate: input.candidate,
      createdAt: new Date().toISOString(),
      payload: {
        changed_paths: diff.changedPaths,
        diff_sha256: diff.diffSha256,
        builder_summary: builderAccepted.result.summary
      }
    });
    await this.core.artifacts.recordHandoff(input.candidate.factoryRunId, builderHandoff.manifest);
    const accepted = await this.core.runRole({
      role: "verifier",
      factoryRunId: input.context.factoryRunId,
      stageAttemptId: ids.stageAttemptId,
      invocationId: ids.invocationId,
      lifecycleState: "verifying",
      stageAttemptOrdinal: 1,
      issue: issueInput(input.issue),
      worktreePath,
      branchRef: input.candidate.branchRef,
      baseSha: input.candidate.baseSha,
      candidate: input.candidate,
      instructions: ["Independently verify every acceptance criterion and configured command."],
      policyRefs: [],
      priorHandoffs: [builderHandoff.manifest],
      priorAcceptedResults: [builderAccepted],
      rolePayload: {
        required_commands: settings.validationCommands,
        changed_paths: diff.changedPaths,
        diff_sha256: diff.diffSha256
      }
    });
    const verifierHandoff = createHandoffManifest({
      handoffId: handoffId("verifier_to_reviewer", accepted.result_sha256),
      kind: "verifier_to_reviewer",
      accepted,
      candidate: input.candidate,
      createdAt: new Date().toISOString(),
      payload: {
        changed_paths: diff.changedPaths,
        diff_sha256: diff.diffSha256,
        builder_handoff_sha256: builderHandoff.sha256,
        verifier_summary: accepted.result.summary
      }
    });
    await this.core.artifacts.recordHandoff(input.candidate.factoryRunId, verifierHandoff.manifest);
    return rolePolicy("verifier").adaptLegacyResult(accepted);
  }

  async runReviewer(input: Readonly<{
    context: EffectInvocationContext;
    issue: FactoryIssue;
    candidate: CandidateRelease;
  }>): Promise<ReviewerResult> {
    const ids = idsFromEffectIntent(input.context.effectIntentId);
    const settings = this.core.settings();
    const worktreePath = join(settings.stateRoot, "runs", input.candidate.factoryRunId, "worktree");
    const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: settings.stateRoot, TMPDIR: settings.stateRoot, LANG: "C", LC_ALL: "C", TZ: "UTC" };
    const diff = await candidateDiffFacts({ worktreePath, baseSha: input.candidate.baseSha, headSha: input.candidate.headCommitSha, environment });
    const verifierAccepted = await this.core.artifacts.findLatestAccepted(input.candidate.factoryRunId, "verifier");
    const verifierHandoff = await this.core.artifacts.findLatestHandoff(input.candidate.factoryRunId, "verifier_to_reviewer");
    const accepted = await this.core.runRole({
      role: "reviewer",
      factoryRunId: input.context.factoryRunId,
      stageAttemptId: ids.stageAttemptId,
      invocationId: ids.invocationId,
      lifecycleState: "reviewing",
      stageAttemptOrdinal: 1,
      issue: issueInput(input.issue),
      worktreePath,
      branchRef: input.candidate.branchRef,
      baseSha: input.candidate.baseSha,
      candidate: input.candidate,
      instructions: ["Review correctness and security, then classify residual release risk."],
      policyRefs: [{ policy_id: settings.reviewerRiskPolicy.policyId, sha256: settings.reviewerRiskPolicy.sha256 }],
      priorHandoffs: [verifierHandoff],
      priorAcceptedResults: [verifierAccepted],
      rolePayload: {
        changed_paths: diff.changedPaths,
        diff_sha256: diff.diffSha256,
        risk_policy_id: settings.reviewerRiskPolicy.policyId,
        risk_policy_sha256: settings.reviewerRiskPolicy.sha256
      }
    });
    const authorizeHandoff = createHandoffManifest({
      handoffId: handoffId("reviewer_to_authorize", accepted.result_sha256),
      kind: "reviewer_to_authorize",
      accepted,
      candidate: input.candidate,
      createdAt: new Date().toISOString(),
      payload: {
        changed_paths: diff.changedPaths,
        diff_sha256: diff.diffSha256,
        risk_classification: accepted.result.role_result.risk_classification,
        reviewer_summary: accepted.result.summary
      }
    });
    await this.core.artifacts.recordHandoff(input.candidate.factoryRunId, authorizeHandoff.manifest);
    return rolePolicy("reviewer").adaptLegacyResult(accepted);
  }
}
