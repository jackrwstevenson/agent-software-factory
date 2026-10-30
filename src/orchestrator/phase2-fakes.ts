import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, canonicalSha256 } from "../protocol/canonical-json.js";
import {
  parseStageAttemptId,
  type Digest,
  type WorkerResult
} from "../protocol/contracts.js";
import type { RoleRuntime } from "../roles/port.js";
import type { ReleaseTopology } from "../runtime/port.js";
import type { TelemetryEngine } from "../telemetry/port.js";
import type { Clock, IdGenerator } from "./ports.js";

export interface Phase2FakeLaterAdapters {
  readonly roleRuntime: RoleRuntime;
  readonly releaseTopology: ReleaseTopology;
  readonly telemetryEngine: TelemetryEngine;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

class CryptoIdGenerator implements IdGenerator {
  next(prefix: "az" | "evt" | "fe" | "fx" | "fr"): string {
    return `${prefix}_${randomUUID()}`;
  }
}

function evidence(value: unknown): Digest {
  return canonicalSha256(value);
}

export function createPhase2FakeLaterAdapters(): Phase2FakeLaterAdapters {
  const clock = new SystemClock();
  const idGenerator = new CryptoIdGenerator();
  return {
    clock,
    idGenerator,
    roleRuntime: {
      async runBuilder(input) {
        const stageAttemptId = parseStageAttemptId(
          `fa_${input.context.effectIntentId.slice("fx_".length)}`
        );
        const candidateFixture = {
          contract: "phase2_fake_builder_change",
          factoryRunId: input.context.factoryRunId,
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          stageAttemptId
        };
        const path = join(
          input.preparedSource.worktreePath,
          ".factory-phase2",
          `${input.context.factoryRunId}.json`
        );
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, `${canonicalJson(candidateFixture)}\n`, "utf8");
        return {
          decision: "changes_ready" as const,
          stageAttemptId,
          builderEvidenceDigest: evidence(candidateFixture),
          summary: "Phase 2 fake Builder wrote a deterministic isolated-worktree fixture"
        };
      },
      async runVerifier(input) {
        return {
          decision: "passed" as const,
          candidateHeadSha: input.candidate.headCommitSha,
          evidenceDigest: evidence({
            role: "verifier",
            candidateHeadSha: input.candidate.headCommitSha
          })
        };
      },
      async runReviewer(input) {
        return {
          decision: "review_complete" as const,
          review: {
            candidateHeadSha: input.candidate.headCommitSha,
            disposition: "review_complete" as const,
            riskClassification: "low" as const,
            evidenceDigest: evidence({
              role: "reviewer",
              candidateHeadSha: input.candidate.headCommitSha
            })
          }
        };
      }
    },
    releaseTopology: {
      async prepareRollout(input) {
        return {
          candidateHeadSha: input.candidate.headCommitSha,
          stagingPassed: true,
          allProgressiveGatesPassed: true,
          candidateExposureBasisPoints: 10000,
          stableAvailable: true,
          evidenceDigest: evidence({
            fake: "release_topology",
            candidateHeadSha: input.candidate.headCommitSha
          })
        };
      }
    },
    telemetryEngine: {
      async evaluateRollout(input): Promise<WorkerResult> {
        return {
          schemaVersion: "1.0",
          contract: "worker_result",
          role: "rollout_babysitter",
          factoryRunId: input.context.factoryRunId,
          candidateHeadSha: input.candidate.headCommitSha,
          inputSha256: canonicalSha256({
            factoryRunId: input.context.factoryRunId,
            candidate: input.candidate,
            rollout: input.rollout
          }),
          decision: "enter_observation",
          facts: {
            candidateExposureBasisPoints: input.rollout.candidateExposureBasisPoints,
            stableAvailable: input.rollout.stableAvailable
          }
        };
      },
      async evaluateObservation(input): Promise<WorkerResult> {
        return {
          schemaVersion: "1.0",
          contract: "worker_result",
          role: "rollout_babysitter",
          factoryRunId: input.context.factoryRunId,
          candidateHeadSha: input.candidate.headCommitSha,
          inputSha256: canonicalSha256({
            factoryRunId: input.context.factoryRunId,
            candidate: input.candidate
          }),
          decision: "observation_passed",
          facts: {
            observationComplete: true,
            telemetryPassed: true,
            unresolvedIncidentCount: 0
          }
        };
      }
    }
  };
}
