import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFactoryRunCommand,
  LEGAL_TRANSITIONS,
  stageForLifecycleState,
  type FactoryRunCommand,
  type FactoryRunState
} from "../../src/domain/factory-run.js";
import type {
  Authorization,
  CandidateRelease,
  LifecycleState,
  RiskClassification
} from "../../src/protocol/contracts.js";
import { parseDigest, parseFactoryRunId, parseGitObjectId, type Digest, parseAuthorizationId, parseIssueId, parseStageAttemptId } from "../../src/protocol/contracts.js";

const digest = (character: string): Digest => parseDigest(character.repeat(64));
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

function authorization(kind: "autonomous_low" | "human", decision: "authorized" | "rejected"): Authorization {
  return {
    schemaVersion: "1.0",
    contract: "authorization",
    authorizationId: parseAuthorizationId(`az_${kind}_${decision}`),
    kind,
    decision,
    factoryRunId: candidate.factoryRunId,
    candidateHeadSha: candidate.headCommitSha,
    riskClassification: kind === "autonomous_low" ? "low" : "elevated",
    recordedAt: "2026-09-28T12:00:00.000Z",
    evidenceDigest: digest("a")
  };
}

function apply(state: FactoryRunState | null, command: FactoryRunCommand): FactoryRunState {
  const result = applyFactoryRunCommand(state, command);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.state;
}

function created(): FactoryRunState {
  return apply(null, {
    kind: "create_run",
    authority: "orchestrator",
    factoryRunId: candidate.factoryRunId,
    issueId: parseIssueId("fixture")
  });
}

function verifying(): FactoryRunState {
  return apply(created(), {
    kind: "transition",
    authority: "orchestrator",
    to: "verifying",
    reason: "built",
    evidence: { candidate, builderEvidenceDigest: digest("b") }
  });
}

function reviewing(): FactoryRunState {
  return apply(verifying(), {
    kind: "transition",
    authority: "orchestrator",
    to: "reviewing",
    reason: "verified",
    evidence: {
      candidateHeadSha: candidate.headCommitSha,
      verificationEvidenceDigest: digest("c")
    }
  });
}

function authorizing(riskClassification: RiskClassification): FactoryRunState {
  return apply(reviewing(), {
    kind: "transition",
    authority: "orchestrator",
    to: "authorizing",
    reason: "reviewed",
    evidence: {
      review: {
        candidateHeadSha: candidate.headCommitSha,
        disposition: "review_complete",
        riskClassification,
        evidenceDigest: digest("d")
      }
    }
  });
}

function awaiting(): FactoryRunState {
  return apply(authorizing("elevated"), {
    kind: "transition",
    authority: "orchestrator",
    to: "awaiting_human_authorization",
    reason: "human gate",
    evidence: {
      authorizationRequest: {
        candidateHeadSha: candidate.headCommitSha,
        evidenceDigest: digest("e")
      }
    }
  });
}

function rollingOut(): FactoryRunState {
  return apply(authorizing("low"), {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_out",
    reason: "authorized",
    evidence: { authorization: authorization("autonomous_low", "authorized") }
  });
}

function observing(): FactoryRunState {
  return apply(rollingOut(), {
    kind: "transition",
    authority: "orchestrator",
    to: "observing",
    reason: "rollout passed",
    evidence: {
      rollout: {
        candidateHeadSha: candidate.headCommitSha,
        stagingPassed: true,
        allProgressiveGatesPassed: true,
        candidateExposureBasisPoints: 10000,
        stableAvailable: true,
        evidenceDigest: digest("f")
      }
    }
  });
}

function rollingBack(trigger: "safety" | "human_abort"): FactoryRunState {
  return apply(rollingOut(), {
    kind: "transition",
    authority: "orchestrator",
    to: "rolling_back",
    reason: "rollback required",
    evidence: {
      rollback: {
        trigger,
        candidateHeadSha: candidate.headCommitSha,
        candidateExposureBasisPoints: 500,
        evidenceDigest: digest("1")
      }
    }
  });
}

function sourceState(from: LifecycleState, to: LifecycleState): FactoryRunState {
  switch (from) {
    case "building":
      return created();
    case "verifying":
      return verifying();
    case "reviewing":
      return reviewing();
    case "authorizing":
      return authorizing(to === "rejected" ? "prohibited" : to === "awaiting_human_authorization" ? "elevated" : "low");
    case "awaiting_human_authorization":
      return awaiting();
    case "rolling_out":
      return rollingOut();
    case "observing":
      return observing();
    case "rolling_back":
      return rollingBack(to === "aborted" ? "human_abort" : "safety");
    case "paused_for_operator": {
      if (to === "rolling_back") {
        return apply(rollingOut(), {
          kind: "transition",
          authority: "orchestrator",
          to: "paused_for_operator",
          reason: "pause after exposure",
          evidence: {
            pause: {
              blockedStage: "rollout",
              reason: "pause after exposure",
              candidateExposureBasisPoints: 500
            }
          }
        });
      }
      const prior = to === "aborted" ? created() : sourceState(to, "paused_for_operator");
      const blockedStage = stageForLifecycleState(prior.lifecycleState);
      assert.notEqual(blockedStage, null);
      return apply(prior, {
        kind: "transition",
        authority: "orchestrator",
        to: "paused_for_operator",
        reason: "protective pause",
        evidence: {
          pause: {
            blockedStage: blockedStage as NonNullable<typeof blockedStage>,
            reason: "protective pause",
            candidateExposureBasisPoints: prior.candidateExposureBasisPoints
          }
        }
      });
    }
    case "succeeded":
    case "rejected":
    case "failed":
    case "rolled_back":
    case "aborted":
      throw new Error(`terminal source ${from} has no legal edge`);
  }
}

function commandFor(from: LifecycleState, to: LifecycleState, state: FactoryRunState): FactoryRunCommand {
  const base = { kind: "transition", authority: "orchestrator", to, reason: `${from} -> ${to}` } as const;
  if (to === "paused_for_operator") {
    const blockedStage = stageForLifecycleState(from);
    assert.notEqual(blockedStage, null);
    return {
      ...base,
      evidence: {
        pause: {
          blockedStage: blockedStage as NonNullable<typeof blockedStage>,
          reason: "protective pause",
          candidateExposureBasisPoints: state.candidateExposureBasisPoints
        }
      }
    };
  }
  if (from === "paused_for_operator" && to === state.paused?.priorState) {
    return { ...base, evidence: { resumption: { reconciled: true, evidenceDigest: digest("2") } } };
  }
  if (to === "failed") {
    if (from === "rolling_back") {
      return {
        ...base,
        evidence: {
          rollbackConfirmation: { stableRestoration: "failed", evidenceDigest: digest("3") }
        }
      };
    }
    return {
      ...base,
      evidence: { failure: { reason: "unrecoverable failure", candidateExposureBasisPoints: 0 } }
    };
  }
  if (to === "aborted") {
    if (from === "rolling_back") {
      return {
        ...base,
        evidence: {
          rollbackConfirmation: { stableRestoration: "confirmed", evidenceDigest: digest("4") }
        }
      };
    }
    return {
      ...base,
      evidence: { abort: { reason: "human abort", candidateExposureBasisPoints: 0 } }
    };
  }
  if (to === "rolling_back") {
    return {
      ...base,
      evidence: {
        rollback: {
          trigger: "safety",
          candidateHeadSha: candidate.headCommitSha,
          candidateExposureBasisPoints: from === "observing" ? 10000 : 500,
          evidenceDigest: digest("5")
        }
      }
    };
  }
  if (from === "building" && to === "verifying") {
    return { ...base, evidence: { candidate, builderEvidenceDigest: digest("6") } };
  }
  if (from === "verifying" && to === "reviewing") {
    return {
      ...base,
      evidence: {
        candidateHeadSha: candidate.headCommitSha,
        verificationEvidenceDigest: digest("7")
      }
    };
  }
  if ((from === "verifying" || from === "reviewing") && to === "building") {
    return {
      ...base,
      evidence: {
        repair: {
          candidateHeadSha: candidate.headCommitSha,
          requestedBy: from === "verifying" ? "verifier" : "reviewer",
          evidenceDigest: digest("8")
        }
      }
    };
  }
  if (from === "reviewing" && to === "authorizing") {
    return {
      ...base,
      evidence: {
        review: {
          candidateHeadSha: candidate.headCommitSha,
          disposition: "review_complete",
          riskClassification: "low",
          evidenceDigest: digest("9")
        }
      }
    };
  }
  if (from === "authorizing" && to === "rolling_out") {
    return { ...base, evidence: { authorization: authorization("autonomous_low", "authorized") } };
  }
  if (from === "authorizing" && to === "awaiting_human_authorization") {
    return {
      ...base,
      evidence: {
        authorizationRequest: {
          candidateHeadSha: candidate.headCommitSha,
          evidenceDigest: digest("a")
        }
      }
    };
  }
  if (from === "authorizing" && to === "rejected") {
    return {
      ...base,
      evidence: {
        rejection: {
          candidateHeadSha: candidate.headCommitSha,
          source: "policy",
          evidenceDigest: digest("b")
        }
      }
    };
  }
  if (from === "awaiting_human_authorization" && to === "rolling_out") {
    return { ...base, evidence: { authorization: authorization("human", "authorized") } };
  }
  if (from === "awaiting_human_authorization" && to === "rejected") {
    return { ...base, evidence: { authorization: authorization("human", "rejected") } };
  }
  if (from === "rolling_out" && to === "observing") {
    return {
      ...base,
      evidence: {
        rollout: {
          candidateHeadSha: candidate.headCommitSha,
          stagingPassed: true,
          allProgressiveGatesPassed: true,
          candidateExposureBasisPoints: 10000,
          stableAvailable: true,
          evidenceDigest: digest("c")
        }
      }
    };
  }
  if (from === "observing" && to === "succeeded") {
    return {
      ...base,
      evidence: {
        observation: {
          candidateHeadSha: candidate.headCommitSha,
          windowComplete: true,
          telemetryPassed: true,
          unresolvedIncidentCount: 0,
          evidenceDigest: digest("d")
        }
      }
    };
  }
  if (from === "rolling_back" && to === "rolled_back") {
    return {
      ...base,
      evidence: {
        rollbackConfirmation: { stableRestoration: "confirmed", evidenceDigest: digest("e") }
      }
    };
  }
  throw new Error(`missing legal-edge fixture for ${from} -> ${to}`);
}

test("every legal lifecycle edge has an accepted guarded example", () => {
  for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS) as [
    LifecycleState,
    readonly LifecycleState[]
  ][]) {
    for (const to of targets) {
      const source = sourceState(from, to);
      const result = applyFactoryRunCommand(source, commandFor(from, to, source));
      assert.equal(
        result.ok,
        true,
        result.ok ? undefined : `${from} -> ${to}: ${result.error.code}: ${result.error.message}`
      );
      if (result.ok) assert.equal(result.state.lifecycleState, to);
    }
  }
});
