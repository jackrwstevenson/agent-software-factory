import { createHash } from "node:crypto";

import { parseDigest, type Digest } from "./contracts.js";

export const CANONICAL_DIGEST_ALGORITHM = "sha256-canonical-json-v1" as const;

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function encodeCanonical(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical JSON requires finite numbers at ${path}`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encodeCanonical(item, `${path}[${index}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const child = record[key];
        if (child === undefined) {
          throw new TypeError(`canonical JSON cannot encode undefined at ${path}.${key}`);
        }
        return `${JSON.stringify(key)}:${encodeCanonical(child, `${path}.${key}`)}`;
      });
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`canonical JSON cannot encode ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, "$");
}

export function canonicalSha256(value: unknown): Digest {
  return parseDigest(createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"));
}
