#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createPhase2ControlEnvironment } from "./control/phase2-adapters.js";
import { FileRunStore, type RunSnapshot } from "./journal/file-run-store.js";
import { createFixtureAdapters } from "./orchestrator/fakes.js";
import { FileOrchestratorLock } from "./orchestrator/file-lock.js";
import { createPhase2FakeLaterAdapters } from "./orchestrator/phase2-fakes.js";
import { runOnceFactory } from "./orchestrator/run-once.js";
import { canonicalJson } from "./protocol/canonical-json.js";
import {
  parseEffectIntentId,
  parseFactoryRunId
} from "./protocol/contracts.js";

interface RunOnceOptions {
  readonly scenario: "fixture" | "phase2";
  readonly stateRoot: string;
}

interface PreflightOptions {
  readonly stateRoot: string;
}

interface BootstrapOptions extends PreflightOptions {
  readonly issueNumber: number;
}

function usage(message?: string): never {
  if (message !== undefined) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage:\n" +
      "  factory run-once --scenario fixture [--state-root <directory>]\n" +
      "  factory run-once --scenario phase2 --state-root <directory>\n" +
      "  factory preflight --state-root <directory>\n" +
      "  factory bootstrap-source-control --state-root <directory> --issue <number>\n"
  );
  process.exitCode = 2;
  throw new Error("invalid command line");
}

function parseRunOnce(arguments_: readonly string[]): RunOnceOptions {
  let scenario: string | undefined;
  let stateRoot = process.env.FACTORY_STATE_ROOT;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--scenario") {
      scenario = arguments_[index + 1];
      index += 1;
    } else if (argument === "--state-root") {
      const value = arguments_[index + 1];
      if (value === undefined) usage("--state-root requires a directory");
      stateRoot = value;
      index += 1;
    } else {
      usage(`unknown argument: ${argument ?? ""}`);
    }
  }

  if (scenario !== "fixture" && scenario !== "phase2") {
    usage("--scenario must be fixture or phase2");
  }
  if (stateRoot === undefined || stateRoot === "") {
    if (scenario === "phase2") usage("phase2 requires --state-root outside all repository checkouts");
    stateRoot = resolve(".factory-state");
  }
  return { scenario, stateRoot: resolve(stateRoot) };
}

function parsePreflight(arguments_: readonly string[]): PreflightOptions {
  let stateRoot = process.env.FACTORY_STATE_ROOT;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--state-root") {
      stateRoot = arguments_[index + 1];
      index += 1;
    } else {
      usage(`unknown argument: ${argument ?? ""}`);
    }
  }
  if (stateRoot === undefined || stateRoot === "") {
    usage("preflight requires --state-root outside all repository checkouts");
  }
  return { stateRoot: resolve(stateRoot) };
}

function parseBootstrap(arguments_: readonly string[]): BootstrapOptions {
  let stateRoot = process.env.FACTORY_STATE_ROOT;
  let issueNumber: number | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--state-root") {
      stateRoot = arguments_[index + 1];
      index += 1;
    } else if (argument === "--issue") {
      const value = arguments_[index + 1] ?? "";
      issueNumber = Number.parseInt(value, 10);
      index += 1;
    } else {
      usage(`unknown argument: ${argument ?? ""}`);
    }
  }
  if (stateRoot === undefined || stateRoot === "") {
    usage("bootstrap-source-control requires --state-root outside all repository checkouts");
  }
  if (issueNumber === null || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    usage("bootstrap-source-control requires a positive --issue number");
  }
  return { stateRoot: resolve(stateRoot), issueNumber };
}

async function findActiveRun(stateRoot: string): Promise<Readonly<{
  runDirectory: string;
  store: FileRunStore;
  snapshot: RunSnapshot;
}> | null> {
  const runsRoot = resolve(stateRoot, "runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const active = [] as Array<Readonly<{
    runDirectory: string;
    store: FileRunStore;
    snapshot: RunSnapshot;
  }>>;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDirectory = resolve(runsRoot, entry.name);
    const store = new FileRunStore(runDirectory);
    const snapshot = await store.load();
    if (snapshot !== null && snapshot.state.terminalOutcome === null) {
      active.push({ runDirectory, store, snapshot });
    }
  }
  if (active.length > 1) throw new Error("orchestrator_conflict: multiple nonterminal Factory Runs exist");
  return active[0] ?? null;
}

function printSnapshot(snapshot: RunSnapshot): void {
  process.stdout.write(
    `${canonicalJson({
      candidateHeadSha: snapshot.state.candidate?.headCommitSha ?? null,
      lastEventDigest: snapshot.lastEventDigest,
      lifecycleState: snapshot.state.lifecycleState,
      stateDigest: snapshot.stateDigest,
      terminalOutcome: snapshot.state.terminalOutcome,
      version: snapshot.version
    })}\n`
  );
}

async function runPhase2(stateRoot: string): Promise<void> {
  const lock = await FileOrchestratorLock.acquire(resolve(stateRoot, "lock"));
  try {
    const environment = createPhase2ControlEnvironment({
      repositoryRoot: process.cwd(),
      stateRoot
    });
    const githubEvidence = await environment.githubControl.preflight();
    const active = await findActiveRun(stateRoot);
    const sourceControl = await environment.sourceControlFor(
      githubEvidence,
      new Date().toISOString(),
      active?.snapshot.state.factoryRunId
    );
    await sourceControl.preflight(
      active === null
        ? undefined
        : {
            knownFactoryRunId: active.snapshot.state.factoryRunId,
            knownIssueNumber: Number.parseInt(active.snapshot.state.issueId, 10)
          }
    );

    const later = createPhase2FakeLaterAdapters();
    let store = active?.store;
    if (store === undefined) {
      let claim = await environment.githubControl.reconcilePendingClaim();
      if (claim.status === "no_work") {
        const factoryRunId = parseFactoryRunId(later.idGenerator.next("fr"));
        claim = await environment.githubControl.claimOldestReady({
          context: {
            effectIntentId: parseEffectIntentId(later.idGenerator.next("fx")),
            factoryRunId
          },
          claimEventId: later.idGenerator.next("fe"),
          claimedAt: later.clock.now()
        });
      }
      if (claim.status === "paused") throw new Error(`${claim.reason}: ${claim.detail}`);
      if (claim.status === "no_work") {
        process.stdout.write(`${canonicalJson({ status: "no_work" })}\n`);
        return;
      }
      await environment.bindSourceCapability(claim.claim.factoryRunId);
      store = new FileRunStore(resolve(stateRoot, "runs", claim.claim.factoryRunId));
    }

    const snapshot = await runOnceFactory({
      store,
      githubControl: environment.githubControl,
      sourceControl,
      ...later
    });
    printSnapshot(snapshot);
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "bootstrap-source-control") {
    const options = parseBootstrap(arguments_);
    const lock = await FileOrchestratorLock.acquire(resolve(options.stateRoot, "lock"));
    try {
      const environment = createPhase2ControlEnvironment({
        repositoryRoot: process.cwd(),
        stateRoot: options.stateRoot
      });
      const github = await environment.githubControl.preflight();
      const capability = await environment.bootstrapLinkedBranches(
        github,
        options.issueNumber,
        new Date().toISOString()
      );
      process.stdout.write(`${canonicalJson({ capability })}\n`);
    } finally {
      await lock.release();
    }
    return;
  }
  if (command === "preflight") {
    const options = parsePreflight(arguments_);
    const lock = await FileOrchestratorLock.acquire(resolve(options.stateRoot, "lock"));
    try {
      const environment = createPhase2ControlEnvironment({
        repositoryRoot: process.cwd(),
        stateRoot: options.stateRoot
      });
      const github = await environment.githubControl.preflight();
      const active = await findActiveRun(options.stateRoot);
      const sourceControl = await environment.sourceControlFor(
        github,
        new Date().toISOString(),
        active?.snapshot.state.factoryRunId
      );
      const source = await sourceControl.preflight(
        active === null
          ? undefined
          : {
              knownFactoryRunId: active.snapshot.state.factoryRunId,
              knownIssueNumber: Number.parseInt(active.snapshot.state.issueId, 10)
            }
      );
      process.stdout.write(`${canonicalJson({ github, source })}\n`);
    } finally {
      await lock.release();
    }
    return;
  }
  if (command !== "run-once") usage(`unknown command: ${command ?? ""}`);
  const options = parseRunOnce(arguments_);
  if (options.scenario === "phase2") {
    await runPhase2(options.stateRoot);
    return;
  }
  const runDirectory = resolve(options.stateRoot, "runs", "fr_fixture_001");
  const fixture = createFixtureAdapters();
  printSnapshot(await runOnceFactory({
    store: new FileRunStore(runDirectory),
    ...fixture.adapters
  }));
}

main().catch((error: unknown) => {
  if (process.exitCode === 2) return;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`factory: ${message}\n`);
  process.exitCode = 1;
});
