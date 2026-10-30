import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { canonicalJson } from "../protocol/canonical-json.js";
import { validateProtocol } from "../protocol/schemas.js";

interface LockRecord {
  readonly schemaVersion: "1.0";
  readonly contract: "orchestrator_lock";
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

export class FileOrchestratorLock {
  readonly #path: string;
  readonly #token: string;
  #released = false;

  private constructor(path: string, token: string) {
    this.#path = path;
    this.#token = token;
  }

  static async acquire(path: string): Promise<FileOrchestratorLock> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const record: LockRecord = {
      schemaVersion: "1.0",
      contract: "orchestrator_lock",
      token,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString()
    };
    const validation = validateProtocol<LockRecord>("orchestrator-lock", record);
    if (!validation.ok) throw new Error(`orchestrator lock contract violation: ${validation.errors.join("; ")}`);
    let handle;
    for (;;) {
      try {
        handle = await open(path, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingValue = JSON.parse(await readFile(path, "utf8")) as unknown;
        const existing = validateProtocol<LockRecord>("orchestrator-lock", existingValue);
        if (!existing.ok) {
          throw new Error(`orchestrator_conflict: invalid existing lock: ${existing.errors.join("; ")}`);
        }
        let active = true;
        if (existing.value.hostname === hostname()) {
          try {
            process.kill(existing.value.pid, 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "ESRCH") active = false;
          }
        }
        if (active) {
          throw new Error(`orchestrator_conflict: another Orchestrator owns ${path}`);
        }
        try {
          await rename(path, `${path}.stale.${existing.value.token}`);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
        }
      }
    }
    try {
      await handle.write(`${canonicalJson(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return new FileOrchestratorLock(path, token);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    const value = JSON.parse(await readFile(this.#path, "utf8")) as unknown;
    const validation = validateProtocol<LockRecord>("orchestrator-lock", value);
    if (!validation.ok) throw new Error(`orchestrator lock contract violation: ${validation.errors.join("; ")}`);
    if (validation.value.token !== this.#token) {
      throw new Error("orchestrator_conflict: lock ownership changed before release");
    }
    await unlink(this.#path);
    this.#released = true;
  }
}
