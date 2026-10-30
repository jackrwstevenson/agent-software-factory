import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import type { RoleCancellationReason } from "./contracts.js";
import { RoleRuntimeError } from "./errors.js";

export interface ProcessCancellationPolicy {
  readonly interruptGraceMs: number;
  readonly terminateGraceMs: number;
  readonly killGraceMs: number;
}

export interface ProcessInspector {
  readBirthIdentity(pid: number): Promise<string | null>;
}

export interface ProcessGroupController {
  exists(pgid: number): boolean | "ambiguous";
  signal(pgid: number, signal: NodeJS.Signals): void;
  liveMembers?(pgid: number): Promise<readonly number[] | "ambiguous">;
}

export interface BoundedProcessRequest {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly deadlineMs: number;
  readonly eventsLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly cancellation: ProcessCancellationPolicy;
  readonly signal?: AbortSignal;
  readonly externalCancellationReason?: Exclude<RoleCancellationReason, "timeout" | "evidence_limit_exceeded">;
  readonly secretValues: readonly string[];
  readonly processInspector?: ProcessInspector;
  readonly processGroupController?: ProcessGroupController;
  readonly onStarted?: (process: Readonly<{
    pid: number;
    pgid: number;
    birthIdentity: string;
    startedAt: string;
  }>) => Promise<void>;
}

export interface BoundedProcessResult {
  readonly pid: number;
  readonly pgid: number;
  readonly birthIdentity: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly cancellationReason: RoleCancellationReason | null;
  readonly events: Buffer;
  readonly stderr: Buffer;
  readonly eventsSha256: string;
  readonly stderrSha256: string;
  readonly processGroupAbsent: boolean;
  readonly leakedDescendant: boolean;
}

const SECRET_KEY = /(?:^|_)(?:CODEX|OPENAI|GH|GITHUB|SSH|AWS|AZURE|GOOGLE)(?:_|$)|(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function leaderExists(pid: number): boolean | "ambiguous" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return "ambiguous";
    throw error;
  }
}

function posixGroupExists(pgid: number): boolean | "ambiguous" {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") {
      const leader = leaderExists(pgid);
      return leader === true ? "ambiguous" : false;
    }
    throw error;
  }
}

function posixSignalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM") return;
    throw error;
  }
}

async function posixLiveGroupMembers(pgid: number): Promise<readonly number[] | "ambiguous"> {
  return await new Promise((resolve) => {
    const child = spawn("ps", ["-axo", "pid=,pgid=,stat="], { stdio: ["ignore", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => resolve("ambiguous"));
    child.once("close", (code) => {
      if (code !== 0) { resolve("ambiguous"); return; }
      const members = Buffer.concat(stdout).toString("utf8").split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 3 && Number(parts[1]) === pgid && !(parts[2] as string).startsWith("Z"))
        .map((parts) => Number(parts[0]));
      resolve(members);
    });
  });
}

export const posixProcessGroupController: ProcessGroupController = {
  exists: posixGroupExists,
  signal: posixSignalGroup,
  liveMembers: posixLiveGroupMembers
};

async function waitForGroupAbsent(
  pgid: number,
  waitMs: number,
  controller: ProcessGroupController
): Promise<boolean> {
  const started = process.hrtime.bigint();
  const limit = BigInt(Math.max(0, waitMs)) * 1_000_000n;
  do {
    const exists = controller.exists(pgid);
    if (exists === false) return true;
    if (controller.liveMembers !== undefined) {
      const members = await controller.liveMembers(pgid);
      if (members !== "ambiguous" && members.length === 0) return true;
    }
    if (exists === "ambiguous") return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, waitMs))));
  } while (process.hrtime.bigint() - started < limit);
  if (controller.exists(pgid) === false) return true;
  if (controller.liveMembers !== undefined) {
    const members = await controller.liveMembers(pgid);
    return members !== "ambiguous" && members.length === 0;
  }
  return false;
}

async function cancelProcessGroup(
  pgid: number,
  policy: ProcessCancellationPolicy,
  controller: ProcessGroupController
): Promise<boolean> {
  controller.signal(pgid, "SIGINT");
  if (await waitForGroupAbsent(pgid, policy.interruptGraceMs, controller)) return true;
  controller.signal(pgid, "SIGTERM");
  if (await waitForGroupAbsent(pgid, policy.terminateGraceMs, controller)) return true;
  controller.signal(pgid, "SIGKILL");
  return await waitForGroupAbsent(pgid, policy.killGraceMs, controller);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(child)
      ])
    );
  }
  return value;
}

function replaceSecretLiterals(text: string, secretValues: readonly string[]): string {
  return secretValues
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), text);
}

function redactJsonLines(buffer: Buffer, secretValues: readonly string[]): Buffer {
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const redacted = lines.map((line) => {
    if (line === "") return line;
    try {
      return JSON.stringify(redactValue(JSON.parse(line) as unknown));
    } catch {
      return line;
    }
  }).join("\n");
  return Buffer.from(replaceSecretLiterals(redacted, secretValues), "utf8");
}

function redactText(buffer: Buffer, secretValues: readonly string[]): Buffer {
  return Buffer.from(replaceSecretLiterals(buffer.toString("utf8"), secretValues), "utf8");
}


async function readPosixProcessBirthIdentity(pid: number): Promise<string | null> {
  const observed = await new Promise<Readonly<{ exitCode: number; stdout: string }>>((resolve) => {
    const child = spawn("/bin/ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", () => resolve({ exitCode: -1, stdout: "" }));
    child.once("close", (code) => resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8")
    }));
  });
  if (observed.exitCode !== 0 || observed.stdout.trim() === "") return null;
  return createHash("sha256").update(`${pid}\0${observed.stdout.trim()}`).digest("hex");
}

export const posixProcessInspector: ProcessInspector = {
  readBirthIdentity: readPosixProcessBirthIdentity
};

export async function readProcessBirthIdentity(
  pid: number,
  inspector: ProcessInspector = posixProcessInspector
): Promise<string | null> {
  return await inspector.readBirthIdentity(pid);
}

export async function reconcileRecordedRoleProcess(input: Readonly<{
  pid: number;
  pgid: number;
  birthIdentity: string;
  cancellation?: Partial<ProcessCancellationPolicy>;
  processInspector?: ProcessInspector;
  processGroupController?: ProcessGroupController;
}>): Promise<"absent" | "cancelled" | "ambiguous"> {
  const observedBirth = await readProcessBirthIdentity(input.pid, input.processInspector ?? posixProcessInspector);
  const controller = input.processGroupController ?? posixProcessGroupController;
  const exists = controller.exists(input.pgid);
  if (observedBirth === null && exists === false) return "absent";
  if (observedBirth === null || observedBirth !== input.birthIdentity || exists === "ambiguous") return "ambiguous";
  const policy: ProcessCancellationPolicy = {
    interruptGraceMs: input.cancellation?.interruptGraceMs ?? 5_000,
    terminateGraceMs: input.cancellation?.terminateGraceMs ?? 5_000,
    killGraceMs: input.cancellation?.killGraceMs ?? 5_000
  };
  return await cancelProcessGroup(input.pgid, policy, controller) ? "cancelled" : "ambiguous";
}

export async function runBoundedProcess(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
  const startedAt = new Date().toISOString();
  const monotonicStart = process.hrtime.bigint();
  let child;
  try {
    child = spawn(request.executablePath, request.args, {
      cwd: request.cwd,
      env: request.environment,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    throw new RoleRuntimeError("spawn_failed", `failed to spawn Codex: ${String(error)}`);
  }

  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    throw new RoleRuntimeError("spawn_failed", "Codex process did not report a PID");
  }

  const eventChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let eventBytes = 0;
  let stderrBytes = 0;
  let cancellationReason: RoleCancellationReason | null = null;
  let cancellationPromise: Promise<boolean> | null = null;

  const requestCancellation = (reason: RoleCancellationReason): void => {
    if (cancellationReason !== null) return;
    cancellationReason = reason;
    cancellationPromise = cancelProcessGroup(pid, request.cancellation, request.processGroupController ?? posixProcessGroupController);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    eventBytes += chunk.length;
    if (eventBytes <= request.eventsLimitBytes) eventChunks.push(chunk);
    else requestCancellation("evidence_limit_exceeded");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= request.stderrLimitBytes) stderrChunks.push(chunk);
    else requestCancellation("evidence_limit_exceeded");
  });

  const close = new Promise<Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    }
  );

  const birthIdentity = await readProcessBirthIdentity(pid, request.processInspector ?? posixProcessInspector);
  if (birthIdentity === null) {
    child.kill("SIGKILL");
    await close.catch(() => undefined);
    throw new RoleRuntimeError("spawn_failed", "could not record Codex OS process birth identity");
  }
  try {
    await request.onStarted?.({ pid, pgid: pid, birthIdentity, startedAt });
  } catch (error) {
    requestCancellation("protocol_violation");
    if (cancellationPromise !== null) await cancellationPromise;
    await close.catch(() => undefined);
    throw new RoleRuntimeError("worker_protocol_error", `failed to persist live role process: ${String(error)}`);
  }

  const deadlineTimer = setInterval(() => {
    const elapsedMs = Number(process.hrtime.bigint() - monotonicStart) / 1_000_000;
    if (elapsedMs >= request.deadlineMs) requestCancellation("timeout");
  }, Math.min(25, Math.max(1, request.deadlineMs)));
  deadlineTimer.unref();

  const abortListener = (): void => requestCancellation(
    request.externalCancellationReason ?? "operator_request"
  );
  request.signal?.addEventListener("abort", abortListener, { once: true });

  child.stdin.end(request.prompt, "utf8");

  let closed: Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  try {
    closed = await close;
  } catch (error) {
    requestCancellation("protocol_violation");
    if (cancellationPromise !== null) await cancellationPromise;
    throw new RoleRuntimeError("spawn_failed", `Codex process failed: ${String(error)}`);
  } finally {
    clearInterval(deadlineTimer);
    request.signal?.removeEventListener("abort", abortListener);
  }

  const groupController = request.processGroupController ?? posixProcessGroupController;
  let processGroupAbsent = groupController.exists(pid) === false;
  if (!processGroupAbsent && groupController.liveMembers !== undefined) {
    const members = await groupController.liveMembers(pid);
    processGroupAbsent = members !== "ambiguous" && members.length === 0;
  }
  let leakedDescendant = false;
  if (!processGroupAbsent) {
    leakedDescendant = cancellationReason === null;
    if (cancellationReason === null) cancellationReason = "protocol_violation";
    cancellationPromise ??= cancelProcessGroup(pid, request.cancellation, groupController);
    processGroupAbsent = await cancellationPromise;
  } else if (cancellationPromise !== null) {
    processGroupAbsent = await cancellationPromise;
  }

  const rawEvents = Buffer.concat(eventChunks);
  const rawStderr = Buffer.concat(stderrChunks);
  const events = redactJsonLines(rawEvents, request.secretValues);
  const stderr = redactText(rawStderr, request.secretValues);
  const completedAt = new Date().toISOString();
  const durationMs = Number(process.hrtime.bigint() - monotonicStart) / 1_000_000;

  return {
    pid,
    pgid: pid,
    birthIdentity,
    exitCode: closed.exitCode,
    signal: closed.signal,
    startedAt,
    completedAt,
    durationMs,
    cancellationReason,
    events,
    stderr,
    eventsSha256: digest(rawEvents),
    stderrSha256: digest(rawStderr),
    processGroupAbsent,
    leakedDescendant
  };
}

export async function runPreflightCommand(input: Readonly<{
  executablePath: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.executablePath, input.args, {
      cwd: input.cwd,
      env: input.environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) posixSignalGroup(child.pid, "SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new RoleRuntimeError("timed_out", `preflight command timed out: ${input.args.join(" ")}`));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
