import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const scratch = process.env.FACTORY_SCRATCH_DIR;
if (!scratch) throw new Error("FACTORY_SCRATCH_DIR is required for read-only verification");
await mkdir(scratch, { recursive: true, mode: 0o700 });
const testDirectory = resolve("examples/tiny-tasks/test");
const tests = (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.mjs"))
  .toSorted()
  .map((name) => resolve(testDirectory, name));
const child = spawn(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  env: { PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: scratch, TZ: "UTC", LANG: "C" }
});
const code = await new Promise((resolveCode) => child.once("close", resolveCode));
process.exitCode = typeof code === "number" ? code : 1;
