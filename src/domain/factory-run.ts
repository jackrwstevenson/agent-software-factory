import type {
  Authorization,
  CandidateRelease,
  Digest,
  FactoryRunId,
  GitObjectId,
  IssueId,
  LifecycleState,
  RiskClassification,
  Stage,
  TerminalOutcome
} from "../protocol/contracts.js";
import { validateProtocol } from "../protocol/schemas.js";

export type TransitionAuthority = "orchestrator" | "observer" | "rollout_babysitter" | "human";

export interface ReviewEvidence {
  readonly candidateHeadSha: GitObjectId;
  readonly disposition: "review_complete";
  readonly riskClassification: RiskClassification;
  readonly evidenceDigest: Digest;
}

export interface RolloutEvidence {
  readonly candidateHeadSha: GitObjectId;
  readonly stagingPassed: boolean;
  readonly allProgressiveGatesPassed: boolean;
  readonly candidateExposureBasisPoints: number;
  readonly stableAvailable: boolean;
  readonly evidenceDigest: Digest;
}

export interface ObservationEvidence {
  readonly candidateHeadSha: GitObjectId;
  readonly windowComplete: boolean;
  readonly telemetryPassed: boolean;
  readonly unresolvedIncidentCount: number;
  readonly evidenceDigest: Digest;
}

export interface RepairEvidence {
  readonly candidateHeadSha: GitObjectId;
  readonly requestedBy: "verifier" | "reviewer";
  readonly evidenceDigest: Digest;
}

export interface AuthorizationRequestEvidence {
  readonly candidateHeadSha: GitObjectId;
  readonly evidenceDigest: Digest;
}

export interface RejectionEvidence {
  readonly candidateHeadSha: GitObjectId;
  readonly source: "policy" | "human";
  readonly evidenceDigest: Digest;
}

export interface PauseEvidence {
  readonly blockedStage: Stage;
  readonly reason: string;
  readonly candidateExposureBasisPoints?: number;
}

export interface ResumptionEvidence {
  readonly reconciled: true;
  readonly evidenceDigest: Digest;
}

export interface AbortEvidence {
  readonly reason: string;
  readonly candidateExposureBasisPoints: number;
}

export interface FailureEvidence {
  readonly reason: string;
  readonly candidateExposureBasisPoints: number;
}

export interface RollbackEvidence {
  readonly trigger: "safety" | "human_abort";
  readonly candidateHeadSha: GitObjectId;
  readonly candidateExposureBasisPoints: number;
  readonly evidenceDigest: Digest;
}

export interface RollbackConfirmationEvidence {
  readonly stableRestoration: "confirmed" | "failed";
  readonly evidenceDigest: Digest;
}

export interface TransitionEvidence {
  readonly candidate?: CandidateRelease;
  readonly builderEvidenceDigest?: Digest;
  readonly candidateHeadSha?: GitObjectId;
  readonly verificationEvidenceDigest?: Digest;
  readonly review?: ReviewEvidence;
  readonly authorization?: Authorization;
  readonly rollout?: RolloutEvidence;
  readonly observation?: ObservationEvidence;
  readonly repair?: RepairEvidence;
  readonly authorizationRequest?: AuthorizationRequestEvidence;
  readonly rejection?: RejectionEvidence;
  readonly pause?: PauseEvidence;
  readonly resumption?: ResumptionEvidence;
  readonly abort?: AbortEvidence;
  readonly failure?: FailureEvidence;
  readonly rollback?: RollbackEvidence;
  readonly rollbackConfirmation?: RollbackConfirmationEvidence;
}

export type FactoryRunCommand =
  | {
      readonly kind: "create_run";
      readonly authority: TransitionAuthority;
      readonly factoryRunId: FactoryRunId;
      readonly issueId: IssueId;
    }
  | {
      readonly kind: "transition";
      readonly authority: TransitionAuthority;
      readonly to: LifecycleState;
      readonly reason: string;
      readonly evidence: TransitionEvidence;
    };

export interface FactoryRunState {
  readonly schemaVersion: "1.0";
  readonly factoryRunId: FactoryRunId;
  readonly issueId: IssueId;
  readonly version: number;
  readonly lifecycleState: LifecycleState;
  readonly candidate: CandidateRelease | null;
  readonly candidateHistory: readonly CandidateRelease[];
  readonly builderEvidenceDigest: Digest | null;
  readonly verification: Readonly<{ candidateHeadSha: GitObjectId; evidenceDigest: Digest }> | null;
  readonly review: ReviewEvidence | null;
  readonly authorization: Authorization | null;
  readonly rollout: RolloutEvidence | null;
  readonly observation: ObservationEvidence | null;
  readonly candidateExposureBasisPoints: number;
  readonly paused: Readonly<{ priorState: LifecycleState; blockedStage: Stage; reason: string }> | null;
  readonly rollback: RollbackEvidence | null;
  readonly terminalOutcome: TerminalOutcome | null;
}

export type DomainErrorCode =
  | "RUN_ALREADY_EXISTS"
  | "RUN_NOT_CREATED"
  | "AUTHORITY_VIOLATION"
  | "WORKER_AUTHORITY_VIOLATION"
  | "TERMINAL_OUTCOME_IMMUTABLE"
  | "ILLEGAL_TRANSITION"
  | "INVALID_CANDIDATE"
  | "STALE_CANDIDATE"
  | "STALE_AUTHORIZATION"
  | "GUARD_REJECTED";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
}

export type DomainResult =
  | { readonly ok: true; readonly state: FactoryRunState }
  | { readonly ok: false; readonly error: DomainError };

export const LEGAL_TRANSITIONS = {
  building: ["verifying", "failed", "aborted", "paused_for_operator"],
  verifying: ["reviewing", "building", "failed", "aborted", "paused_for_operator"],
  reviewing: ["authorizing", "building", "failed", "aborted", "paused_for_operator"],
  authorizing: [
    "rolling_out",
    "awaiting_human_authorization",
    "rejected",
    "failed",
    "aborted",
    "paused_for_operator"
  ],
  awaiting_human_authorization: ["rolling_out", "rejected", "aborted", "paused_for_operator"],
  rolling_out: ["observing", "rolling_back", "failed", "aborted", "paused_for_operator"],
  observing: ["succeeded", "rolling_back", "paused_for_operator"],
  rolling_back: ["rolled_back", "aborted", "failed", "paused_for_operator"],
  paused_for_operator: [
    "building",
    "verifying",
    "reviewing",
    "authorizing",
    "awaiting_human_authorization",
    "rolling_out",
    "observing",
    "rolling_back",
    "aborted"
  ],
  succeeded: [],
  rejected: [],
  failed: [],
  rolled_back: [],
  aborted: []
} as const satisfies Readonly<Record<LifecycleState, readonly LifecycleState[]>>;

const terminalStates = new Set<LifecycleState>([
  "succeeded",
  "rejected",
  "failed",
  "rolled_back",
  "aborted"
]);

function rejected(code: DomainErrorCode, message: string): DomainResult {
  return { ok: false, error: { code, message } };
}

function ensureOrchestrator(authority: TransitionAuthority): DomainResult | null {
  if (authority === "observer" || authority === "rollout_babysitter") {
    return rejected(
      "WORKER_AUTHORITY_VIOLATION",
      `${authority} may supply evidence or a proposal but cannot transition a Factory Run`
    );
  }
  if (authority !== "orchestrator") {
    return rejected("AUTHORITY_VIOLATION", "only the Orchestrator may record Lifecycle State");
  }
  return null;
}

export function stageForLifecycleState(state: LifecycleState): Stage | null {
  switch (state) {
    case "building":
      return "build";
    case "verifying":
      return "verify";
    case "reviewing":
      return "review";
    case "authorizing":
    case "awaiting_human_authorization":
      return "authorize";
    case "rolling_out":
    case "rolling_back":
      return "rollout";
    case "observing":
      return "observe";
    case "paused_for_operator":
    case "succeeded":
    case "rejected":
    case "failed":
    case "rolled_back":
    case "aborted":
      return null;
  }
}

function exactCandidate(state: FactoryRunState, candidateHeadSha: GitObjectId | undefined): DomainResult | null {
  if (state.candidate === null || candidateHeadSha !== state.candidate.headCommitSha) {
    return rejected("STALE_CANDIDATE", "evidence is not bound to the current Candidate Release");
  }
  return null;
}

function candidateBoundAuthorizationFailure(
  state: FactoryRunState,
  authorization: Authorization | undefined
): DomainResult | null {
  if (authorization === undefined) {
    return rejected("GUARD_REJECTED", "Rollout requires a recorded Authorization");
  }
  const validation = validateProtocol<Authorization>("authorization", authorization);
  if (!validation.ok || authorization.factoryRunId !== state.factoryRunId) {
    return rejected("STALE_AUTHORIZATION", "Authorization failed its versioned contract or run binding");
  }
  if (authorization.candidateHeadSha !== state.candidate?.headCommitSha) {
    return rejected("STALE_AUTHORIZATION", "Authorization is bound to a superseded Candidate Release");
  }
  return null;
}

function transitioned(
  state: FactoryRunState,
  lifecycleState: LifecycleState,
  patch: Partial<FactoryRunState>
): DomainResult {
  const terminalOutcome = terminalStates.has(lifecycleState) ? (lifecycleState as TerminalOutcome) : null;
  return {
    ok: true,
    state: {
      ...state,
      ...patch,
      version: state.version + 1,
      lifecycleState,
      terminalOutcome
    }
  };
}

export function applyFactoryRunCommand(
  state: FactoryRunState | null,
  command: FactoryRunCommand
): DomainResult {
  const authorityFailure = ensureOrchestrator(command.authority);
  if (authorityFailure !== null) return authorityFailure;

  if (command.kind === "create_run") {
    if (state !== null) return rejected("RUN_ALREADY_EXISTS", "a Factory Run already exists");
    return {
      ok: true,
      state: {
        schemaVersion: "1.0",
        factoryRunId: command.factoryRunId,
        issueId: command.issueId,
        version: 1,
        lifecycleState: "building",
        candidate: null,
        candidateHistory: [],
        builderEvidenceDigest: null,
        verification: null,
        review: null,
        authorization: null,
        rollout: null,
        observation: null,
        candidateExposureBasisPoints: 0,
        paused: null,
        rollback: null,
        terminalOutcome: null
      }
    };
  }

  if (state === null) return rejected("RUN_NOT_CREATED", "create the Factory Run before transitioning it");
  if (state.terminalOutcome !== null) {
    return rejected("TERMINAL_OUTCOME_IMMUTABLE", "a Terminal Outcome has no outgoing transition");
  }

  const { evidence, to } = command;
  const legalTargets = LEGAL_TRANSITIONS[state.lifecycleState] as readonly LifecycleState[];
  if (!legalTargets.includes(to)) {
    return rejected(
      "ILLEGAL_TRANSITION",
      `${state.lifecycleState} cannot transition directly to ${to}`
    );
  }

  if (to === "paused_for_operator") {
    const blockedStage = stageForLifecycleState(state.lifecycleState);
    if (evidence.pause === undefined || blockedStage === null || evidence.pause.blockedStage !== blockedStage) {
      return rejected("GUARD_REJECTED", "pause must retain the exact blocked Stage and reason");
    }
    const exposure = evidence.pause.candidateExposureBasisPoints ?? state.candidateExposureBasisPoints;
    if (!Number.isInteger(exposure) || exposure < 0 || exposure > 10000) {
      return rejected("GUARD_REJECTED", "pause exposure must use integer basis points");
    }
    if (state.candidateExposureBasisPoints > 0 && exposure !== state.candidateExposureBasisPoints) {
      return rejected("GUARD_REJECTED", "pause cannot replace authoritative Candidate exposure");
    }
    return transitioned(state, to, {
      candidateExposureBasisPoints: exposure,
      paused: {
        priorState: state.lifecycleState,
        blockedStage,
        reason: evidence.pause.reason
      }
    });
  }

  if (state.lifecycleState === "paused_for_operator" && to === state.paused?.priorState) {
    if (evidence.resumption?.reconciled !== true) {
      return rejected("GUARD_REJECTED", "resume requires durable reconciliation evidence");
    }
    return transitioned(state, to, { paused: null });
  }

  if (
    (state.lifecycleState === "rolling_out" ||
      state.lifecycleState === "observing" ||
      state.lifecycleState === "paused_for_operator") &&
    to === "rolling_back"
  ) {
    if (evidence.rollback === undefined) {
      return rejected("GUARD_REJECTED", "rollback requires a Candidate-bound trigger and exposure");
    }
    const candidateFailure = exactCandidate(state, evidence.rollback.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    if (evidence.rollback.candidateExposureBasisPoints <= 0) {
      return rejected("GUARD_REJECTED", "rollback is required only after nonzero Candidate exposure");
    }
    if (
      state.candidateExposureBasisPoints > 0 &&
      evidence.rollback.candidateExposureBasisPoints !== state.candidateExposureBasisPoints
    ) {
      return rejected("GUARD_REJECTED", "rollback must use authoritative Candidate exposure");
    }
    return transitioned(state, to, {
      rollback: evidence.rollback,
      candidateExposureBasisPoints: evidence.rollback.candidateExposureBasisPoints,
      paused: null
    });
  }

  if (state.lifecycleState === "rolling_back" && (to === "rolled_back" || to === "aborted" || to === "failed")) {
    if (evidence.rollbackConfirmation === undefined || state.rollback === null) {
      return rejected("GUARD_REJECTED", "rollback termination requires Stable restoration evidence");
    }
    if (to === "failed") {
      if (evidence.rollbackConfirmation.stableRestoration !== "failed") {
        return rejected("GUARD_REJECTED", "Failed requires inability to confirm Stable restoration");
      }
      return transitioned(state, to, {});
    }
    if (evidence.rollbackConfirmation.stableRestoration !== "confirmed") {
      return rejected("GUARD_REJECTED", "rollback completion requires confirmed Stable restoration");
    }
    const expectedOutcome = state.rollback.trigger === "human_abort" ? "aborted" : "rolled_back";
    if (to !== expectedOutcome) {
      return rejected("GUARD_REJECTED", `${state.rollback.trigger} rollback must end ${expectedOutcome}`);
    }
    return transitioned(state, to, {});
  }

  if (to === "failed") {
    if (evidence.failure === undefined) {
      return rejected("GUARD_REJECTED", "failure requires a typed reason and exposure fact");
    }
    if (evidence.failure.candidateExposureBasisPoints !== state.candidateExposureBasisPoints) {
      return rejected("GUARD_REJECTED", "failure cannot replace authoritative Candidate exposure");
    }
    if (evidence.failure.candidateExposureBasisPoints !== 0) {
      return rejected("GUARD_REJECTED", "failure after Candidate exposure must enter rollback");
    }
    return transitioned(state, to, {
      candidateExposureBasisPoints: evidence.failure.candidateExposureBasisPoints
    });
  }

  if (to === "aborted") {
    if (evidence.abort === undefined) {
      return rejected("GUARD_REJECTED", "abort requires a human reason and exposure fact");
    }
    if (evidence.abort.candidateExposureBasisPoints !== state.candidateExposureBasisPoints) {
      return rejected("GUARD_REJECTED", "abort cannot replace authoritative Candidate exposure");
    }
    if (evidence.abort.candidateExposureBasisPoints !== 0) {
      return rejected("GUARD_REJECTED", "abort after Candidate exposure must enter rollback");
    }
    return transitioned(state, to, { candidateExposureBasisPoints: 0 });
  }

  if (state.lifecycleState === "building" && to === "verifying") {
    if (evidence.candidate === undefined || evidence.builderEvidenceDigest === undefined) {
      return rejected("GUARD_REJECTED", "Build requires a Candidate Release and demonstration evidence");
    }
    const validation = validateProtocol<CandidateRelease>("candidate-release", evidence.candidate);
    if (!validation.ok || evidence.candidate.factoryRunId !== state.factoryRunId) {
      return rejected("INVALID_CANDIDATE", "Candidate Release failed its versioned contract or run binding");
    }
    const expectedOrdinal = state.candidateHistory.length + 1;
    if (evidence.candidate.candidateOrdinal !== expectedOrdinal) {
      return rejected("INVALID_CANDIDATE", `Candidate ordinal must be ${expectedOrdinal}`);
    }
    if (
      state.candidateHistory.some(
        (priorCandidate) => priorCandidate.headCommitSha === evidence.candidate?.headCommitSha
      )
    ) {
      return rejected("INVALID_CANDIDATE", "a replacement Candidate must have a new head commit SHA");
    }
    return transitioned(state, to, {
      candidate: evidence.candidate,
      candidateHistory: [...state.candidateHistory, evidence.candidate],
      builderEvidenceDigest: evidence.builderEvidenceDigest,
      verification: null,
      review: null,
      authorization: null,
      rollout: null,
      observation: null,
      paused: null,
      rollback: null
    });
  }

  if (
    (state.lifecycleState === "verifying" || state.lifecycleState === "reviewing") &&
    to === "building"
  ) {
    if (evidence.repair === undefined) {
      return rejected("GUARD_REJECTED", "return to Build requires a structured repair request");
    }
    const candidateFailure = exactCandidate(state, evidence.repair.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    const expectedRequester = state.lifecycleState === "verifying" ? "verifier" : "reviewer";
    if (evidence.repair.requestedBy !== expectedRequester) {
      return rejected("GUARD_REJECTED", `${expectedRequester} must own this repair request`);
    }
    return transitioned(state, to, {
      verification: null,
      review: null,
      authorization: null,
      rollout: null,
      observation: null
    });
  }

  if (state.lifecycleState === "verifying" && to === "reviewing") {
    const candidateFailure = exactCandidate(state, evidence.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    if (evidence.verificationEvidenceDigest === undefined) {
      return rejected("GUARD_REJECTED", "Verify requires durable automated-check evidence");
    }
    return transitioned(state, to, {
      verification: {
        candidateHeadSha: state.candidate!.headCommitSha,
        evidenceDigest: evidence.verificationEvidenceDigest
      }
    });
  }

  if (state.lifecycleState === "reviewing" && to === "authorizing") {
    if (evidence.review === undefined) {
      return rejected("GUARD_REJECTED", "Review requires a complete Candidate-bound decision");
    }
    const candidateFailure = exactCandidate(state, evidence.review.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    return transitioned(state, to, { review: evidence.review });
  }

  if (state.lifecycleState === "authorizing" && to === "awaiting_human_authorization") {
    if (state.review?.riskClassification !== "elevated" || evidence.authorizationRequest === undefined) {
      return rejected("GUARD_REJECTED", "only an Elevated exact Candidate may enter the human gate");
    }
    const candidateFailure = exactCandidate(state, evidence.authorizationRequest.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    return transitioned(state, to, {});
  }

  if (state.lifecycleState === "authorizing" && to === "rejected") {
    if (state.review?.riskClassification !== "prohibited" || evidence.rejection?.source !== "policy") {
      return rejected("GUARD_REJECTED", "policy rejection requires a Prohibited exact Candidate");
    }
    const candidateFailure = exactCandidate(state, evidence.rejection.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    return transitioned(state, to, {});
  }

  if (state.lifecycleState === "authorizing" && to === "rolling_out") {
    const authorizationFailure = candidateBoundAuthorizationFailure(state, evidence.authorization);
    if (authorizationFailure !== null) return authorizationFailure;
    const authorization = evidence.authorization as Authorization;
    if (
      state.review?.riskClassification !== "low" ||
      authorization.kind !== "autonomous_low" ||
      authorization.riskClassification !== "low" ||
      authorization.decision !== "authorized"
    ) {
      return rejected("GUARD_REJECTED", "only Low autonomous Authorization may leave Authorize directly");
    }
    return transitioned(state, to, { authorization });
  }

  if (
    state.lifecycleState === "awaiting_human_authorization" &&
    (to === "rolling_out" || to === "rejected")
  ) {
    const authorizationFailure = candidateBoundAuthorizationFailure(state, evidence.authorization);
    if (authorizationFailure !== null) return authorizationFailure;
    const authorization = evidence.authorization as Authorization;
    if (
      authorization.kind !== "human" ||
      authorization.riskClassification !== "elevated" ||
      state.review?.riskClassification !== "elevated"
    ) {
      return rejected("GUARD_REJECTED", "human Authorization must match the Elevated Reviewer decision");
    }
    const expectedDecision = to === "rolling_out" ? "authorized" : "rejected";
    if (authorization.decision !== expectedDecision) {
      return rejected("GUARD_REJECTED", `human decision must be ${expectedDecision}`);
    }
    return transitioned(state, to, { authorization });
  }

  if (state.lifecycleState === "rolling_out" && to === "observing") {
    if (evidence.rollout === undefined) {
      return rejected("GUARD_REJECTED", "Rollout requires Candidate-bound gate evidence");
    }
    const candidateFailure = exactCandidate(state, evidence.rollout.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    if (
      !evidence.rollout.stagingPassed ||
      !evidence.rollout.allProgressiveGatesPassed ||
      evidence.rollout.candidateExposureBasisPoints !== 10000 ||
      !evidence.rollout.stableAvailable
    ) {
      return rejected("GUARD_REJECTED", "Staging, every rollout gate, 100% exposure, and Stable are required");
    }
    return transitioned(state, to, {
      rollout: evidence.rollout,
      candidateExposureBasisPoints: evidence.rollout.candidateExposureBasisPoints
    });
  }

  if (state.lifecycleState === "observing" && to === "succeeded") {
    if (evidence.observation === undefined) {
      return rejected("GUARD_REJECTED", "success requires Observation Window evidence");
    }
    const candidateFailure = exactCandidate(state, evidence.observation.candidateHeadSha);
    if (candidateFailure !== null) return candidateFailure;
    if (
      !evidence.observation.windowComplete ||
      !evidence.observation.telemetryPassed ||
      evidence.observation.unresolvedIncidentCount !== 0
    ) {
      return rejected("GUARD_REJECTED", "Observation Window must be complete, telemetry must pass, and no unresolved Incident may remain");
    }
    return transitioned(state, to, { observation: evidence.observation });
  }

  return rejected(
    "ILLEGAL_TRANSITION",
    `${state.lifecycleState} cannot transition directly to ${command.to}`
  );
}
