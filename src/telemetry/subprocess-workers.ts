import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ObserverInput, ObserverResult } from "./observer.js";
import type { RolloutBabysitterProposal } from "./rollout-babysitter.js";
import {
  acceptBabysitterWorkerOutput,
  acceptObserverWorkerOutput,
  type BabysitterWorkerInput
} from "./worker-protocol.js";

export interface SubprocessWorkerReceipt<T> {
  readonly pid: number;
  readonly output: T;
  readonly exited: true;
}

async function runJsonWorker(role: "observer" | "rollout_babysitter", input: unknown): Promise<Readonly<{ pid: number; output: unknown }>> {
  const entrypoint = fileURLToPath(new URL("./worker-entry.js", import.meta.url));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, role], { stdio: ["pipe", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error(`failed to spawn ${role} worker`));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${role} worker failed (${String(code)}/${String(signal)}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve({ pid, output: JSON.parse(stdout) as unknown });
      } catch (error) {
        reject(new Error(`${role} worker returned invalid JSON: ${String(error)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export class ShortLivedTelemetryWorkers {
  public async runObserver(input: ObserverInput): Promise<SubprocessWorkerReceipt<ObserverResult>> {
    const receipt = await runJsonWorker("observer", input);
    return Object.freeze({ pid: receipt.pid, output: acceptObserverWorkerOutput(input, receipt.output), exited: true });
  }

  public async runBabysitter(input: BabysitterWorkerInput): Promise<SubprocessWorkerReceipt<RolloutBabysitterProposal>> {
    const receipt = await runJsonWorker("rollout_babysitter", input);
    return Object.freeze({ pid: receipt.pid, output: acceptBabysitterWorkerOutput(input, receipt.output), exited: true });
  }
}
