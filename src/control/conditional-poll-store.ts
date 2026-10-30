import { readJsonFile, writeDurableJsonFile } from "../journal/durable-json-file.js";
import { validateProtocol } from "../protocol/schemas.js";

interface ConditionalPollState {
  readonly schemaVersion: "1.0";
  readonly contract: "github_conditional_poll";
  readonly key: string;
  readonly etag: string;
}

export interface ConditionalPollStore {
  load(key: string): Promise<string | null>;
  save(key: string, etag: string): Promise<void>;
}

export class FileConditionalPollStore implements ConditionalPollStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(key: string): Promise<string | null> {
    const value = await readJsonFile(this.#path);
    if (value === null) return null;
    const validation = validateProtocol<ConditionalPollState>("github-conditional-poll", value);
    if (!validation.ok) throw new Error(`conditional poll contract violation: ${validation.errors.join("; ")}`);
    return validation.value.key === key ? validation.value.etag : null;
  }

  async save(key: string, etag: string): Promise<void> {
    const state: ConditionalPollState = {
      schemaVersion: "1.0",
      contract: "github_conditional_poll",
      key,
      etag
    };
    const validation = validateProtocol<ConditionalPollState>("github-conditional-poll", state);
    if (!validation.ok) throw new Error(`conditional poll contract violation: ${validation.errors.join("; ")}`);
    await writeDurableJsonFile(this.#path, state);
  }
}

export class MemoryConditionalPollStore implements ConditionalPollStore {
  readonly #etags = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.#etags.get(key) ?? null;
  }

  async save(key: string, etag: string): Promise<void> {
    this.#etags.set(key, etag);
  }
}
