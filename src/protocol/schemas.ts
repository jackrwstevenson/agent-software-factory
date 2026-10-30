import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import authorizationSchema from "../../schemas/v1/authorization.schema.json" with { type: "json" };
import candidateReleaseSchema from "../../schemas/v1/candidate-release.schema.json" with { type: "json" };
import factoryRunCommandSchema from "../../schemas/v1/factory-run-command.schema.json" with { type: "json" };
import factoryClaimIntentSchema from "../../schemas/v1/factory-claim-intent.schema.json" with { type: "json" };
import githubConditionalPollSchema from "../../schemas/v1/github-conditional-poll.schema.json" with { type: "json" };
import orchestratorLockSchema from "../../schemas/v1/orchestrator-lock.schema.json" with { type: "json" };
import factoryRunStateSchema from "../../schemas/v1/factory-run-state.schema.json" with { type: "json" };
import runEventSchema from "../../schemas/v1/run-event.schema.json" with { type: "json" };
import sourceCapabilitySchema from "../../schemas/v1/source-capability.schema.json" with { type: "json" };
import terminalCleanupReceiptSchema from "../../schemas/v1/terminal-cleanup-receipt.schema.json" with { type: "json" };
import runSnapshotSchema from "../../schemas/v1/run-snapshot.schema.json" with { type: "json" };
import workerResultSchema from "../../schemas/v1/worker-result.schema.json" with { type: "json" };

export type ProtocolSchemaName =
  | "authorization"
  | "candidate-release"
  | "factory-claim-intent"
  | "factory-run-command"
  | "factory-run-state"
  | "github-conditional-poll"
  | "orchestrator-lock"
  | "run-event"
  | "run-snapshot"
  | "source-capability"
  | "terminal-cleanup-receipt"
  | "worker-result";

export type ProtocolValidation<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(candidateReleaseSchema);
ajv.addSchema(factoryClaimIntentSchema);
ajv.addSchema(githubConditionalPollSchema);
ajv.addSchema(orchestratorLockSchema);
ajv.addSchema(authorizationSchema);
ajv.addSchema(factoryRunCommandSchema);
ajv.addSchema(factoryRunStateSchema);
ajv.addSchema(runEventSchema);
ajv.addSchema(runSnapshotSchema);
ajv.addSchema(sourceCapabilitySchema);
ajv.addSchema(terminalCleanupReceiptSchema);
ajv.addSchema(workerResultSchema);

const validators: Readonly<Record<ProtocolSchemaName, ValidateFunction>> = {
  authorization: ajv.getSchema(authorizationSchema.$id) as ValidateFunction,
  "candidate-release": ajv.getSchema(candidateReleaseSchema.$id) as ValidateFunction,
  "factory-claim-intent": ajv.getSchema(factoryClaimIntentSchema.$id) as ValidateFunction,
  "factory-run-command": ajv.getSchema(factoryRunCommandSchema.$id) as ValidateFunction,
  "factory-run-state": ajv.getSchema(factoryRunStateSchema.$id) as ValidateFunction,
  "github-conditional-poll": ajv.getSchema(githubConditionalPollSchema.$id) as ValidateFunction,
  "orchestrator-lock": ajv.getSchema(orchestratorLockSchema.$id) as ValidateFunction,
  "run-event": ajv.getSchema(runEventSchema.$id) as ValidateFunction,
  "run-snapshot": ajv.getSchema(runSnapshotSchema.$id) as ValidateFunction,
  "source-capability": ajv.getSchema(sourceCapabilitySchema.$id) as ValidateFunction,
  "terminal-cleanup-receipt": ajv.getSchema(terminalCleanupReceiptSchema.$id) as ValidateFunction,
  "worker-result": ajv.getSchema(workerResultSchema.$id) as ValidateFunction
};

function formatError(error: ErrorObject): string {
  const location = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  const extra =
    typeof error.params === "object" && "additionalProperty" in error.params
      ? `: ${String(error.params.additionalProperty)}`
      : "";
  return `${location} ${error.message ?? error.keyword}${extra}`;
}

export function validateProtocol<T = unknown>(
  schemaName: ProtocolSchemaName,
  value: unknown
): ProtocolValidation<T> {
  const validator = validators[schemaName];
  if (validator(value)) {
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    errors: (validator.errors ?? []).map(formatError)
  };
}
