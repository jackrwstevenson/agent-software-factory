import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("factory run-once --scenario fixture prints a replay-stable Succeeded summary", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-cli-"));
  try {
    const cli = join(process.cwd(), "dist", "src", "cli.js");
    const arguments_ = [cli, "run-once", "--scenario", "fixture", "--state-root", stateRoot];
    const first = await execFileAsync(process.execPath, arguments_);
    const second = await execFileAsync(process.execPath, arguments_);
    const firstSummary = JSON.parse(first.stdout);
    const secondSummary = JSON.parse(second.stdout);

    assert.equal(firstSummary.lifecycleState, "succeeded");
    assert.equal(firstSummary.terminalOutcome, "succeeded");
    assert.deepEqual(secondSummary, firstSummary);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
