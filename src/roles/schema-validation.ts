import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import handoffManifestSchema from "../../schemas/v1/handoff-manifest.schema.json" with { type: "json" };
import roleInputSchema from "../../schemas/v1/role-input.schema.json" with { type: "json" };
import type { HandoffManifest, RoleInputManifest } from "./contracts.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(handoffManifestSchema);
ajv.addSchema(roleInputSchema);
const inputValidator = ajv.getSchema(roleInputSchema.$id) as ValidateFunction;
const handoffValidator = ajv.getSchema(handoffManifestSchema.$id) as ValidateFunction;

function formatError(error: ErrorObject): string {
  const location = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  const extra =
    typeof error.params === "object" && "additionalProperty" in error.params
      ? `: ${String(error.params.additionalProperty)}`
      : "";
  return `${location} ${error.message ?? error.keyword}${extra}`;
}

function validate<T>(validator: ValidateFunction, value: unknown):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (validator(value)) return { ok: true, value: value as T };
  return { ok: false, errors: (validator.errors ?? []).map(formatError) };
}

export function validateRoleInput(value: unknown) {
  return validate<RoleInputManifest>(inputValidator, value);
}

export function validateHandoffManifest(value: unknown) {
  return validate<HandoffManifest>(handoffValidator, value);
}
