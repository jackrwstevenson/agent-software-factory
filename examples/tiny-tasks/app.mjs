import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "./io.mjs";

export const EMPTY_LIST_COPY = "Nothing here yet.";

export class TaskStore {
  constructor(dataDirectory) {
    this.path = join(dataDirectory, "tasks.json");
  }

  async load() {
    try {
      const tasks = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(tasks)) throw new Error("Tiny Tasks data must be an array");
      return tasks;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        await writeJsonAtomic(this.path, []);
        return [];
      }
      throw error;
    }
  }

  async add(title) {
    const tasks = await this.load();
    const nextId = tasks.reduce((maximum, task) => Math.max(maximum, Number(task.id) || 0), 0) + 1;
    const task = { id: nextId, title, completed: false };
    await writeJsonAtomic(this.path, [...tasks, task]);
    return task;
  }

  async remove(id) {
    const tasks = await this.load();
    const remaining = tasks.filter((task) => task.id !== id);
    if (remaining.length === tasks.length) return false;
    await writeJsonAtomic(this.path, remaining);
    return true;
  }
}

export function taskListRepresentation(tasks) {
  return {
    tasks,
    emptyCopy: tasks.length === 0 ? EMPTY_LIST_COPY : null
  };
}
