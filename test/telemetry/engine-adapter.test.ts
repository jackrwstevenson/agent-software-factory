import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileTelemetryCheckpointStore, JournalTelemetryEngine } from "../../src/telemetry/index.js";
import {
  parseDigest,
  parseEffectIntentId,
  parseFactoryRunId,
  parseGitObjectId,
  parseStageAttemptId,
  type CandidateRelease
} from "../../src/protocol/contracts.js";
import { populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

const candidateSha = parseGitObjectId("1".repeat(40));
const candidate: CandidateRelease = {
  schemaVersion: "1.0",
  contract: "candidate_release",
  factoryRunId: parseFactoryRunId("fr_engine_001"),
  candidateOrdinal: 1,
  builderStageAttemptId: parseStageAttemptId("fa_engine_001"),
  branchRef: "refs/heads/factory/engine",
  baseSha: parseGitObjectId("0".repeat(40)),
  headCommitSha: candidateSha,
  sourceTreeSha: parseGitObjectId("2".repeat(40))
};

test("journal telemetry engine remains compatible with the TelemetryEngine port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-engine-"));
  try {
  const checkpointStore = new FileTelemetryCheckpointStore(join(directory, "checkpoint.json"));
  const run = new TelemetryRunBuilder("engine_001");
  const window = populateHealthyWindow(run.createWindow("engine", "gate_50", {
    candidateReleaseId: candidateSha
  }).open());
  const engine = new JournalTelemetryEngine({
    async loadRolloutEvidence() {
      return { journal: run.journal, windowId: window.binding.windowId, checkpointStore };
    },
    async loadObservationEvidence() {
      throw new Error("not used");
    }
  });

  const result = await engine.evaluateRollout({
    context: {
      effectIntentId: parseEffectIntentId("fx_engine_001"),
      factoryRunId: candidate.factoryRunId
    },
    candidate,
    rollout: {
      candidateHeadSha: candidateSha,
      stagingPassed: true,
      allProgressiveGatesPassed: false,
      candidateExposureBasisPoints: 5_000,
      stableAvailable: true,
      evidenceDigest: parseDigest("a".repeat(64))
    }
  });

  assert.equal(result.role, "rollout_babysitter");
  assert.equal(result.decision, "advance_exposure");
  assert.equal(result.factoryRunId, candidate.factoryRunId);
  assert.equal(result.candidateHeadSha, candidateSha);
  assert.equal(result.facts.candidateExposureBasisPoints, 5_000);
  assert.equal(result.facts.stableAvailable, true);
  const checkpoint = await checkpointStore.load(candidate.factoryRunId);
  assert.ok(checkpoint);
  assert.equal(checkpoint.evaluationSequence, 1);
  assert.notEqual(checkpoint.observerWorkerPid, process.pid);
  assert.notEqual(checkpoint.babysitterWorkerPid, process.pid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
