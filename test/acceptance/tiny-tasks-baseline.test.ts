import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function waitForDescriptor(child: ReturnType<typeof spawn>): Promise<{ port: number; instanceId: string; releaseId: string }> {
  return new Promise((resolveDescriptor, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("Tiny Tasks startup timed out")), 5_000);
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      resolveDescriptor(JSON.parse(stdout.slice(0, newline)) as { port: number; instanceId: string; releaseId: string });
    });
  });
}

test("Tiny Tasks exposes identity-aware health and ordinary isolated task operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiny-tasks-acceptance-"));
  const child = spawn(process.execPath, [resolve("examples/tiny-tasks/server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      FACTORY_DATA_DIR: join(root, "data"),
      FACTORY_INSTANCE_ID: "instance-acceptance",
      FACTORY_RELEASE_ID: "release-acceptance",
      FACTORY_PROCESS_ATTEMPT: "attempt-1",
      FACTORY_OWNERSHIP_NONCE: "nonce-1",
      PORT: "0"
    }
  });
  try {
    const descriptor = await waitForDescriptor(child);
    const base = `http://127.0.0.1:${descriptor.port}`;
    const health = await (await fetch(`${base}/health`)).json() as { status: string; instanceId: string; releaseId: string };
    assert.deepEqual(health, { status: "ok", ready: true, instanceId: "instance-acceptance", releaseId: "release-acceptance", processAttempt: "attempt-1", ownershipNonce: "nonce-1" });
    const empty = await (await fetch(`${base}/tasks`)).json() as { emptyCopy: string };
    assert.equal(empty.emptyCopy, "Nothing here yet.");
    const created = await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "ship the factory" }) });
    assert.equal(created.status, 201);
    const tasks = await (await fetch(`${base}/tasks`)).json() as { tasks: readonly { title: string }[]; emptyCopy: string | null };
    assert.deepEqual(tasks.tasks.map((task) => task.title), ["ship the factory"]);
    assert.equal(tasks.emptyCopy, null);
  } finally {
    const exited = new Promise((resolveExit) => child.once("close", resolveExit));
    child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
