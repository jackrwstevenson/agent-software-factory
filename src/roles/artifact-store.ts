import { chmod, mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../protocol/canonical-json.js";
import type {
  AcceptedRoleResult,
  FactoryRole,
  HandoffManifest,
  RolePostconditions,
  RoleProcessEvidence,
  RoleResult
} from "./contracts.js";
import {
  reconcileRecordedRoleProcess,
  type ProcessCancellationPolicy,
  type ProcessGroupController,
  type ProcessInspector
} from "./process.js";

export interface RoleAttemptPaths {
  readonly directory: string;
  readonly scratch: string;
  readonly home: string;
  readonly temp: string;
}

export interface RoleStartIntent {
  readonly schema_version: "1.0";
  readonly contract: "role_start_intent";
  readonly factory_run_id: string;
  readonly stage_attempt_id: string;
  readonly role: FactoryRole;
  readonly input_sha256: string;
  readonly executable_path: string;
  readonly executable_sha256: string;
  readonly model: string;
  readonly sandbox: "workspace-write" | "read-only";
  readonly deadline_at: string;
  readonly recorded_at: string;
}

export interface LiveRoleProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly birth_identity: string;
  readonly recorded_at: string;
}

async function immutableWrite(path: string, value: unknown): Promise<void> {
  const body = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : `${canonicalJson(value)}\n`;
  await writeFile(path, body, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export class RoleArtifactStore {
  readonly #stateRoot: string;

  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }

  attemptPaths(factoryRunId: string, stageAttemptId: string): RoleAttemptPaths {
    const directory = join(this.#stateRoot, "runs", factoryRunId, "attempts", stageAttemptId);
    const scratch = join(directory, "scratch");
    return { directory, scratch, home: join(scratch, "home"), temp: join(scratch, "tmp") };
  }

  async beginAttempt(input: Readonly<{
    factoryRunId: string;
    stageAttemptId: string;
    role: FactoryRole;
    inputSha256: string;
    executablePath: string;
    executableSha256: string;
    model: string;
    sandbox: "workspace-write" | "read-only";
    deadlineAt: string;
  }>): Promise<RoleAttemptPaths> {
    const paths = this.attemptPaths(input.factoryRunId, input.stageAttemptId);
    await mkdir(join(paths.directory, ".."), { recursive: true, mode: 0o700 });
    await mkdir(paths.directory, { mode: 0o700 });
    await mkdir(paths.scratch, { mode: 0o700 });
    await Promise.all([
      mkdir(paths.home, { mode: 0o700 }),
      mkdir(paths.temp, { mode: 0o700 })
    ]);
    const intent: RoleStartIntent = {
      schema_version: "1.0",
      contract: "role_start_intent",
      factory_run_id: input.factoryRunId,
      stage_attempt_id: input.stageAttemptId,
      role: input.role,
      input_sha256: input.inputSha256,
      executable_path: input.executablePath,
      executable_sha256: input.executableSha256,
      model: input.model,
      sandbox: input.sandbox,
      deadline_at: input.deadlineAt,
      recorded_at: new Date().toISOString()
    };
    await immutableWrite(join(paths.directory, "start-intent.json"), intent);
    return paths;
  }

  async writeImmutable(attempt: RoleAttemptPaths, name: string, value: unknown): Promise<void> {
    await immutableWrite(join(attempt.directory, name), value);
  }

  async recordLiveProcess(attempt: RoleAttemptPaths, process: LiveRoleProcess): Promise<void> {
    await immutableWrite(join(attempt.directory, "process-live.json"), process);
  }

  async recordCompletedProcess(attempt: RoleAttemptPaths, process: RoleProcessEvidence): Promise<void> {
    await immutableWrite(join(attempt.directory, "process.json"), process);
  }

  async recordPostconditions(attempt: RoleAttemptPaths, postconditions: RolePostconditions): Promise<void> {
    await immutableWrite(join(attempt.directory, "postconditions.json"), postconditions);
  }

  async recordAccepted(attempt: RoleAttemptPaths, accepted: AcceptedRoleResult): Promise<void> {
    await immutableWrite(join(attempt.directory, "accepted-result.json"), accepted);
  }

  async loadAccepted(factoryRunId: string, stageAttemptId: string): Promise<AcceptedRoleResult> {
    return await readJson<AcceptedRoleResult>(
      join(this.attemptPaths(factoryRunId, stageAttemptId).directory, "accepted-result.json")
    );
  }

  async findLatestAccepted(factoryRunId: string, role: FactoryRole): Promise<AcceptedRoleResult> {
    const attemptsRoot = join(this.#stateRoot, "runs", factoryRunId, "attempts");
    const candidates: AcceptedRoleResult[] = [];
    const directory = await opendir(attemptsRoot);
    for await (const entry of directory) {
      if (!entry.isDirectory()) continue;
      const acceptedPath = join(attemptsRoot, entry.name, "accepted-result.json");
      if (!await exists(acceptedPath)) continue;
      const accepted = await readJson<AcceptedRoleResult>(acceptedPath);
      if (accepted.result.role === role) candidates.push(accepted);
    }
    const latest = candidates.sort((left, right) =>
      left.accepted_at.localeCompare(right.accepted_at)
    ).at(-1);
    if (latest === undefined) throw new Error(`missing accepted ${role} result for ${factoryRunId}`);
    return latest;
  }

  async recordHandoff(factoryRunId: string, handoff: HandoffManifest): Promise<void> {
    const directory = join(this.#stateRoot, "runs", factoryRunId, "handoffs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await immutableWrite(join(directory, `${handoff.handoff_id}.json`), handoff);
  }

  async findLatestHandoff(factoryRunId: string, kind: HandoffManifest["kind"]): Promise<HandoffManifest> {
    const handoffsRoot = join(this.#stateRoot, "runs", factoryRunId, "handoffs");
    const matches: HandoffManifest[] = [];
    const directory = await opendir(handoffsRoot);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const handoff = await readJson<HandoffManifest>(join(handoffsRoot, entry.name));
      if (handoff.kind === kind) matches.push(handoff);
    }
    const latest = matches.sort((left, right) => left.created_at.localeCompare(right.created_at)).at(-1);
    if (latest === undefined) throw new Error(`missing ${kind} Handoff Manifest for ${factoryRunId}`);
    return latest;
  }

  async reconcilePendingAttempts(input: Readonly<{
    processInspector: ProcessInspector;
    processGroupController: ProcessGroupController;
    cancellation: ProcessCancellationPolicy;
  }>): Promise<readonly Readonly<{
    factoryRunId: string;
    stageAttemptId: string;
    outcome: "absent" | "cancelled" | "ambiguous";
  }>[]> {
    const outcomes: Array<Readonly<{
      factoryRunId: string;
      stageAttemptId: string;
      outcome: "absent" | "cancelled" | "ambiguous";
    }>> = [];
    const runsRoot = join(this.#stateRoot, "runs");
    let runs;
    try { runs = await opendir(runsRoot); } catch { return outcomes; }
    for await (const run of runs) {
      if (!run.isDirectory()) continue;
      const attemptsRoot = join(runsRoot, run.name, "attempts");
      let attempts;
      try { attempts = await opendir(attemptsRoot); } catch { continue; }
      for await (const attempt of attempts) {
        if (!attempt.isDirectory()) continue;
        const directory = join(attemptsRoot, attempt.name);
        const livePath = join(directory, "process-live.json");
        if (
          !await exists(join(directory, "start-intent.json")) ||
          !await exists(livePath) ||
          await exists(join(directory, "process.json")) ||
          await exists(join(directory, "process-reconciliation.json"))
        ) continue;
        const live = await readJson<LiveRoleProcess>(livePath);
        const outcome = await reconcileRecordedRoleProcess({
          pid: live.pid,
          pgid: live.pgid,
          birthIdentity: live.birth_identity,
          processInspector: input.processInspector,
          processGroupController: input.processGroupController,
          cancellation: input.cancellation
        });
        await immutableWrite(join(directory, "process-reconciliation.json"), {
          schema_version: "1.0",
          contract: "role_process_reconciliation",
          outcome,
          reconciled_at: new Date().toISOString()
        });
        outcomes.push({ factoryRunId: run.name, stageAttemptId: attempt.name, outcome });
      }
    }
    return outcomes;
  }

  async readAcceptedResult(path: string): Promise<AcceptedRoleResult<RoleResult>> {
    return await readJson<AcceptedRoleResult<RoleResult>>(path);
  }
}
