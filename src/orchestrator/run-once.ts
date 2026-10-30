import type { FactoryIssue } from "../control/ports.js";
import type { PreparedSource } from "../control/contracts.js";
import type { FactoryRunCommand } from "../domain/factory-run.js";
import type {
  AppendEffectIntentRequest,
  AppendEffectResultRequest,
  EffectPort,
  RunSnapshot,
  RunStore
} from "../journal/file-run-store.js";
import { canonicalSha256 } from "../protocol/canonical-json.js";
import {
  parseAuthorizationId,
  parseEffectIntentId,
  parseEventId,
  parseFactoryRunId,
  type Authorization,
  type Digest,
  type EffectInvocationContext,
  type FactoryRunId,
  type GitObjectId,
  type WorkerResult
} from "../protocol/contracts.js";
import { validateProtocol } from "../protocol/schemas.js";
import {
  observationEvidenceFrom,
  type OrchestratorAdapters
} from "./ports.js";

export interface RunOnceDependencies extends OrchestratorAdapters {
  readonly store: RunStore;
}

async function appendLifecycle(
  dependencies: RunOnceDependencies,
  snapshot: RunSnapshot | null,
  command: FactoryRunCommand
): Promise<RunSnapshot> {
  return dependencies.store.append({
    expectedVersion: snapshot?.version ?? 0,
    eventId: parseEventId(dependencies.idGenerator.next("evt")),
    recordedAt: dependencies.clock.now(),
    command
  });
}

async function performEffect<T>(
  dependencies: RunOnceDependencies,
  snapshot: RunSnapshot,
  port: EffectPort,
  operation: string,
  factoryRunId: FactoryRunId,
  input: unknown,
  invoke: (context: EffectInvocationContext) => Promise<T>
): Promise<readonly [RunSnapshot, T]> {
  const inputDigest = canonicalSha256(input);
  const matching = snapshot.effects.filter(
    (projection) =>
      projection.effect.port === port &&
      projection.effect.operation === operation &&
      projection.inputDigest === inputDigest
  );
  if (matching.length > 1) {
    throw new Error(`conflicting durable effects for ${port}.${operation}`);
  }

  let projection = matching[0];
  let withIntent = snapshot;
  if (projection === undefined) {
    const context: EffectInvocationContext = {
      effectIntentId: parseEffectIntentId(dependencies.idGenerator.next("fx")),
      factoryRunId
    };
    const effect = {
      effectIntentId: context.effectIntentId,
      port,
      operation
    };
    const intent: AppendEffectIntentRequest = {
      expectedVersion: snapshot.version,
      eventId: parseEventId(dependencies.idGenerator.next("evt")),
      recordedAt: dependencies.clock.now(),
      effect,
      inputDigest
    };
    withIntent = await dependencies.store.appendEffectIntent(intent);
    projection = withIntent.effects.find((candidate) => candidate.effect.effectIntentId === context.effectIntentId);
    if (projection === undefined) throw new Error(`effect intent ${context.effectIntentId} was not persisted`);
  }

  const context: EffectInvocationContext = {
    effectIntentId: projection.effect.effectIntentId,
    factoryRunId
  };
  const output = await invoke(context);
  const outputDigest = canonicalSha256(output);
  if (projection.status === "succeeded") {
    if (projection.outputDigest !== outputDigest) {
      throw new Error(`reconciled output conflicts with durable effect ${projection.effect.effectIntentId}`);
    }
    return [withIntent, output];
  }
  const result: AppendEffectResultRequest = {
    expectedVersion: withIntent.version,
    eventId: parseEventId(dependencies.idGenerator.next("evt")),
    recordedAt: dependencies.clock.now(),
    effect: projection.effect,
    outputDigest
  };
  return [await dependencies.store.appendEffectResult(result), output];
}

function acceptWorkerResult(
  result: WorkerResult,
  expected: {
    readonly role: "rollout_babysitter" | "observer";
    readonly factoryRunId: FactoryRunId;
    readonly candidateHeadSha: GitObjectId;
    readonly inputSha256: Digest;
    readonly decision: WorkerResult["decision"];
  }
): WorkerResult {
  const validation = validateProtocol<WorkerResult>("worker-result", result);
  if (!validation.ok) {
    throw new Error(`worker protocol violation: ${validation.errors.join("; ")}`);
  }
  if (
    result.role !== expected.role ||
    result.factoryRunId !== expected.factoryRunId ||
    result.candidateHeadSha !== expected.candidateHeadSha ||
    result.inputSha256 !== expected.inputSha256 ||
    result.decision !== expected.decision
  ) {
    throw new Error("worker result is stale or outside its advisory authority");
  }
  return result;
}

export async function runOnceFactory(dependencies: RunOnceDependencies): Promise<RunSnapshot> {
  let snapshot = await dependencies.store.load();
  await dependencies.githubControl.preflight();
  const knownIssueNumber = snapshot === null ? null : Number.parseInt(snapshot.state.issueId, 10);
  if (knownIssueNumber !== null && (!Number.isSafeInteger(knownIssueNumber) || knownIssueNumber <= 0)) {
    throw new Error(`Factory Run issue ID is not a GitHub issue number: ${snapshot?.state.issueId ?? ""}`);
  }
  const sourcePreflight = await dependencies.sourceControl.preflight(
    snapshot === null || knownIssueNumber === null
      ? undefined
      : { knownFactoryRunId: snapshot.state.factoryRunId, knownIssueNumber }
  );
  let issue: FactoryIssue;

  if (snapshot === null) {
    let claim = await dependencies.githubControl.reconcilePendingClaim();
    if (claim.status === "no_work") {
      const plannedFactoryRunId = parseFactoryRunId(dependencies.idGenerator.next("fr"));
      claim = await dependencies.githubControl.claimOldestReady({
        context: {
          effectIntentId: parseEffectIntentId(dependencies.idGenerator.next("fx")),
          factoryRunId: plannedFactoryRunId
        },
        claimEventId: dependencies.idGenerator.next("fe"),
        claimedAt: dependencies.clock.now()
      });
    }
    if (claim.status === "no_work") throw new Error("no factory:ready issue is available");
    if (claim.status === "paused") throw new Error(`${claim.reason}: ${claim.detail}`);
    const factoryRunId = claim.claim.factoryRunId;
    issue = claim.claim.issue;
    snapshot = await appendLifecycle(dependencies, null, {
      kind: "create_run",
      authority: "orchestrator",
      factoryRunId,
      issueId: issue.issueId
    });
    await dependencies.githubControl.acceptClaim(factoryRunId);
  } else {
    await dependencies.githubControl.acceptClaim(snapshot.state.factoryRunId);
    issue = await dependencies.githubControl.loadIssue(snapshot.state.issueId);
  }

  while (snapshot.state.terminalOutcome === null) {
    const currentIssue = issue;
    const state = snapshot.state;
    const candidate = state.candidate;

    switch (state.lifecycleState) {
      case "building": {
        let preparedSource: PreparedSource;
        [snapshot, preparedSource] = await performEffect(
          dependencies,
          snapshot,
          "SourceControl",
          "prepareRun",
          state.factoryRunId,
          {
            factoryRunId: state.factoryRunId,
            issueNumber: currentIssue.number,
            baseSha: sourcePreflight.defaultBranchSha
          },
          (context) =>
            dependencies.sourceControl.prepareRun({
              context,
              issueNumber: currentIssue.number,
              baseSha: sourcePreflight.defaultBranchSha
            })
        );
        [snapshot] = await performEffect(
          dependencies,
          snapshot,
          "GitHubControl",
          "publishSourceBranch",
          state.factoryRunId,
          {
            factoryRunId: state.factoryRunId,
            issueNumber: currentIssue.number,
            branchName: preparedSource.branchName,
            branchMode: preparedSource.branchMode,
            baseSha: preparedSource.baseSha
          },
          (context) =>
            dependencies.githubControl.publishIssueEvent({
              invocation: context,
              issueNumber: currentIssue.number,
              eventId: `fe_${context.effectIntentId.slice(3)}`,
              event: "source.branch.created",
              candidateSha: null,
              body: [
                `Factory Branch: \`${preparedSource.branchName}\``,
                `Base SHA: \`${preparedSource.baseSha}\``,
                `Branch mode: \`${preparedSource.branchMode}\``
              ].join("\n")
            })
        );
        let build;
        [snapshot, build] = await performEffect(
          dependencies,
          snapshot,
          "RoleRuntime",
          "runBuilder",
          state.factoryRunId,
          { factoryRunId: state.factoryRunId, issue: currentIssue, preparedSource },
          (context) =>
            dependencies.roleRuntime.runBuilder({
              context,
              issue: currentIssue,
              preparedSource
            })
        );
        let nextCandidate;
        [snapshot, nextCandidate] = await performEffect(
          dependencies,
          snapshot,
          "SourceControl",
          "createCandidate",
          state.factoryRunId,
          {
            factoryRunId: state.factoryRunId,
            preparedSource,
            issueNumber: currentIssue.number,
            candidateOrdinal: (candidate?.candidateOrdinal ?? 0) + 1,
            previousCandidateHeadSha: candidate?.headCommitSha ?? null,
            build
          },
          (context) =>
            dependencies.sourceControl.createCandidate({
              context,
              prepared: preparedSource,
              issueNumber: currentIssue.number,
              candidateOrdinal: (candidate?.candidateOrdinal ?? 0) + 1,
              previousCandidateHeadSha: candidate?.headCommitSha ?? null,
              build
            })
        );
        snapshot = await appendLifecycle(dependencies, snapshot, {
          kind: "transition",
          authority: "orchestrator",
          to: "verifying",
          reason: "Builder produced a deterministic Candidate Release",
          evidence: {
            candidate: nextCandidate,
            builderEvidenceDigest: build.builderEvidenceDigest
          }
        });
        break;
      }
      case "verifying": {
        if (candidate === null) throw new Error("Verifying requires a Candidate Release");
        let verification;
        [snapshot, verification] = await performEffect(
          dependencies,
          snapshot,
          "RoleRuntime",
          "runVerifier",
          state.factoryRunId,
          { factoryRunId: state.factoryRunId, issue: currentIssue, candidate },
          (context) =>
            dependencies.roleRuntime.runVerifier({
              context,
              issue: currentIssue,
              candidate
            })
        );
        snapshot = await appendLifecycle(dependencies, snapshot, {
          kind: "transition",
          authority: "orchestrator",
          to: "reviewing",
          reason: "Verifier passed the exact Candidate Release",
          evidence: {
            candidateHeadSha: verification.candidateHeadSha,
            verificationEvidenceDigest: verification.evidenceDigest
          }
        });
        break;
      }
      case "reviewing": {
        if (candidate === null) throw new Error("Reviewing requires a Candidate Release");
        let review;
        [snapshot, review] = await performEffect(
          dependencies,
          snapshot,
          "RoleRuntime",
          "runReviewer",
          state.factoryRunId,
          { factoryRunId: state.factoryRunId, issue: currentIssue, candidate },
          (context) =>
            dependencies.roleRuntime.runReviewer({
              context,
              issue: currentIssue,
              candidate
            })
        );
        [snapshot] = await performEffect(
          dependencies,
          snapshot,
          "SourceControl",
          "readyCandidate",
          state.factoryRunId,
          { factoryRunId: state.factoryRunId, candidate },
          (context) => dependencies.sourceControl.readyCandidate({ context, candidate })
        );
        snapshot = await appendLifecycle(dependencies, snapshot, {
          kind: "transition",
          authority: "orchestrator",
          to: "authorizing",
          reason: "Reviewer completed the exact Candidate Release",
          evidence: { review: review.review }
        });
        break;
      }
      case "authorizing": {
        if (candidate === null || state.review?.riskClassification !== "low") {
          throw new Error("fixture scenario requires a Low-risk exact Candidate");
        }
        const authorization: Authorization = {
          schemaVersion: "1.0",
          contract: "authorization",
          authorizationId: parseAuthorizationId(dependencies.idGenerator.next("az")),
          kind: "autonomous_low",
          decision: "authorized",
          factoryRunId: state.factoryRunId,
          candidateHeadSha: candidate.headCommitSha,
          riskClassification: "low",
          recordedAt: dependencies.clock.now(),
          evidenceDigest: canonicalSha256(state.review)
        };
        snapshot = await appendLifecycle(dependencies, snapshot, {
          kind: "transition",
          authority: "orchestrator",
          to: "rolling_out",
          reason: "Low risk was autonomously authorized",
          evidence: { authorization }
        });
        break;
      }
      case "rolling_out": {
        if (candidate === null) throw new Error("Rollout requires a Candidate Release");
        let rollout;
        [snapshot, rollout] = await performEffect(
          dependencies,
          snapshot,
          "ReleaseTopology",
          "prepareRollout",
          state.factoryRunId,
          { factoryRunId: state.factoryRunId, candidate },
          (context) =>
            dependencies.releaseTopology.prepareRollout({
              context,
              candidate
            })
        );
        const workerInput = { factoryRunId: state.factoryRunId, candidate, rollout };
        let workerResult;
        [snapshot, workerResult] = await performEffect(
          dependencies,
          snapshot,
          "TelemetryEngine",
          "evaluateRollout",
          state.factoryRunId,
          workerInput,
          (context) =>
            dependencies.telemetryEngine.evaluateRollout({
              context,
              candidate,
              rollout
            })
        );
        acceptWorkerResult(workerResult, {
          role: "rollout_babysitter",
          factoryRunId: state.factoryRunId,
          candidateHeadSha: candidate.headCommitSha,
          inputSha256: canonicalSha256(workerInput),
          decision: "enter_observation"
        });
        snapshot = await appendLifecycle(dependencies, snapshot, {
          kind: "transition",
          authority: "orchestrator",
          to: "observing",
          reason: "accepted Babysitter proposal after independent guard validation",
          evidence: { rollout }
        });
        break;
      }
      case "observing": {
        if (candidate === null) throw new Error("Observe requires a Candidate Release");
        const workerInput = { factoryRunId: state.factoryRunId, candidate };
        let workerResult;
        [snapshot, workerResult] = await performEffect(
          dependencies,
          snapshot,
          "TelemetryEngine",
          "evaluateObservation",
          state.factoryRunId,
          workerInput,
          (context) =>
            dependencies.telemetryEngine.evaluateObservation({
              context,
              candidate
            })
        );
        const accepted = acceptWorkerResult(workerResult, {
          role: "rollout_babysitter",
          factoryRunId: state.factoryRunId,
          candidateHeadSha: candidate.headCommitSha,
          inputSha256: canonicalSha256(workerInput),
          decision: "observation_passed"
        });
        [snapshot] = await performEffect(
          dependencies,
          snapshot,
          "SourceControl",
          "integrateCandidate",
          state.factoryRunId,
          { factoryRunId: state.factoryRunId, candidate },
          (context) => dependencies.sourceControl.integrateCandidate({ context, candidate })
        );
        snapshot = await appendLifecycle(dependencies, snapshot, {
          kind: "transition",
          authority: "orchestrator",
          to: "succeeded",
          reason: "Observation Window passed",
          evidence: { observation: observationEvidenceFrom(accepted) }
        });
        break;
      }
      case "awaiting_human_authorization":
      case "rolling_back":
      case "paused_for_operator":
        throw new Error(`fixture scenario cannot automatically continue ${state.lifecycleState}`);
      case "succeeded":
      case "rejected":
      case "failed":
      case "rolled_back":
      case "aborted":
        break;
    }
  }

  const terminalState = snapshot.state;
  const terminalOutcome = terminalState.terminalOutcome;
  if (terminalOutcome === null) throw new Error("Factory Run left the lifecycle loop without a Terminal Outcome");
  let terminalBranchRef = terminalState.candidate?.branchRef ?? null;
  if (terminalState.candidate === null) {
    let branchObservation;
    [snapshot, branchObservation] = await performEffect(
      dependencies,
      snapshot,
      "SourceControl",
      "observeTerminalBranch",
      terminalState.factoryRunId,
      {
        factoryRunId: terminalState.factoryRunId,
        issueNumber: issue.number
      },
      (context) => dependencies.sourceControl.observeTerminalBranch({
        context,
        issueNumber: issue.number
      })
    );
    terminalBranchRef = branchObservation.state === "present"
      ? branchObservation.branchRef
      : null;
  }
  [snapshot] = await performEffect(
    dependencies,
    snapshot,
    "GitHubControl",
    "projectTerminal",
    terminalState.factoryRunId,
    {
      factoryRunId: terminalState.factoryRunId,
      issueNumber: issue.number,
      terminalOutcome,
      candidateSha: terminalState.candidate?.headCommitSha ?? null,
      branchRef: terminalBranchRef
    },
    (invocation) => dependencies.githubControl.projectTerminal({
      invocation,
      issueNumber: issue.number,
      terminalOutcome,
      candidateSha: terminalState.candidate?.headCommitSha ?? null,
      branchRef: terminalBranchRef
    })
  );
  [snapshot] = await performEffect(
    dependencies,
    snapshot,
    "SourceControl",
    "cleanupTerminal",
    terminalState.factoryRunId,
    {
      factoryRunId: terminalState.factoryRunId,
      issueNumber: issue.number,
      terminalOutcome,
      candidate: terminalState.candidate
    },
    (context) => dependencies.sourceControl.cleanupTerminal({
      context,
      issueNumber: issue.number,
      terminalOutcome,
      candidate: terminalState.candidate
    })
  );

  return snapshot;
}

export const runOnceFixture = runOnceFactory;
