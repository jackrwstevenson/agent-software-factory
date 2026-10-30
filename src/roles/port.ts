import type { FactoryIssue } from "../control/ports.js";
import type { PreparedSource } from "../control/contracts.js";
import type { ReviewEvidence } from "../domain/factory-run.js";
import type {
  CandidateRelease,
  Digest,
  EffectInvocationContext,
  GitObjectId,
  StageAttemptId
} from "../protocol/contracts.js";

export interface BuilderResult {
  readonly decision: "changes_ready";
  readonly stageAttemptId: StageAttemptId;
  readonly builderEvidenceDigest: Digest;
  readonly summary: string;
}

export interface VerifierResult {
  readonly decision: "passed";
  readonly candidateHeadSha: GitObjectId;
  readonly evidenceDigest: Digest;
}

export interface ReviewerResult {
  readonly decision: "review_complete";
  readonly review: ReviewEvidence;
}

/**
 * Stable Phase 1/2 adapter boundary. Real role implementations may expose richer
 * accepted decisions through an additional seam, but these methods return only
 * the successful decisions consumed by the current walking skeleton.
 */
export interface RoleRuntime {
  runBuilder(input: {
    readonly context: EffectInvocationContext;
    readonly issue: FactoryIssue;
    readonly preparedSource: PreparedSource;
  }): Promise<BuilderResult>;
  runVerifier(input: {
    readonly context: EffectInvocationContext;
    readonly issue: FactoryIssue;
    readonly candidate: CandidateRelease;
  }): Promise<VerifierResult>;
  runReviewer(input: {
    readonly context: EffectInvocationContext;
    readonly issue: FactoryIssue;
    readonly candidate: CandidateRelease;
  }): Promise<ReviewerResult>;
}
