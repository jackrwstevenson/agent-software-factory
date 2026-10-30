import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EMPTY_LIST_COPY, TaskStore, taskListRepresentation } from "../app.mjs";

test("empty Tiny Tasks list uses the committed baseline copy", () => {
  assert.equal(EMPTY_LIST_COPY, "Nothing here yet.");
  assert.deepEqual(taskListRepresentation([]), { tasks: [], emptyCopy: "Nothing here yet." });
});

test("Tiny Tasks uses isolated deterministic file-backed data", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiny-tasks-"));
  try {
    const store = new TaskStore(root);
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await store.add("first task"), { id: 1, title: "first task", completed: false });
    assert.deepEqual(await store.add("second task"), { id: 2, title: "second task", completed: false });
    assert.equal(await store.remove(1), true);
    assert.deepEqual(await store.load(), [{ id: 2, title: "second task", completed: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
