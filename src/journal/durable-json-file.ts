import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "../protocol/canonical-json.js";

export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDurableJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "w", 0o600);
  try {
    await handle.write(`${canonicalJson(value)}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}
