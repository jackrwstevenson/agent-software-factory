import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "tiny-tasks-verify-"));
try {
  const child = spawn(process.execPath, [resolve("examples/tiny-tasks/verify.mjs")], {
    stdio: "inherit",
    env: { ...process.env, FACTORY_SCRATCH_DIR: scratch }
  });
  const code = await new Promise((resolveCode) => child.once("close", resolveCode));
  process.exitCode = typeof code === "number" ? code : 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
