import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readProcessBirthIdentity(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError("pid must be a positive integer");
  const psPath = process.platform === "linux" ? "/usr/bin/ps" : "/bin/ps";
  const { stdout } = await execFileAsync(psPath, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const started = stdout.trim().replace(/\s+/g, " ");
  if (started.length === 0) throw new Error(`process ${pid} has no observable birth identity`);
  return `${pid}:${started}`;
}
