import sharedRoleResultSchema from "../../schemas/v1/role-result.schema.json" with { type: "json" };

function clone<T>(value: T): T { return structuredClone(value); }
function inferredType(value: unknown): string | null {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (["string", "boolean", "number", "object"].includes(typeof value)) return typeof value;
  return null;
}
function rewriteRefs(value: unknown, sharedId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, sharedId));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith(`${sharedId}#/$defs/`)) {
      output[key] = child.slice(sharedId.length);
    } else output[key] = rewriteRefs(child, sharedId);
  }
  return output;
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || value === null) return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const unsupported = new Set(["$schema", "$id", "title", "description", "uniqueItems", "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum"]);
  for (const [key, child] of Object.entries(input)) if (!unsupported.has(key)) output[key] = normalize(child);
  if (output.type === undefined && output.const !== undefined) output.type = inferredType(output.const);
  if (output.type === undefined && Array.isArray(output.enum) && output.enum.length > 0) {
    const types = new Set(output.enum.map(inferredType));
    if (types.size === 1) output.type = [...types][0];
  }
  if (output.type === "object" && typeof output.properties === "object" && output.properties !== null) {
    output.additionalProperties = false;
    output.required = Object.keys(output.properties as Record<string, unknown>);
  }
  return output;
}

export function providerCompatibleSchema(schema: unknown): unknown { return normalize(clone(schema)); }

export function providerCompatibleRoleSchema(roleSchema: unknown): unknown {
  const shared = clone(sharedRoleResultSchema) as Record<string, unknown>;
  const role = clone(roleSchema) as Record<string, unknown>;
  const overlay = (role.allOf as readonly Record<string, unknown>[] | undefined)?.[1] ?? {};
  const sharedId = String(shared.$id);
  const merged = {
    $schema: shared.$schema,
    title: role.title,
    type: "object",
    additionalProperties: false,
    required: [...new Set([...(shared.required as string[] ?? []), ...(overlay.required as string[] ?? [])])],
    properties: {
      ...(shared.properties as Record<string, unknown> ?? {}),
      ...(overlay.properties as Record<string, unknown> ?? {})
    },
    $defs: {
      ...(shared.$defs as Record<string, unknown> ?? {}),
      ...(role.$defs as Record<string, unknown> ?? {})
    }
  };
  return normalize(rewriteRefs(merged, sharedId));
}
