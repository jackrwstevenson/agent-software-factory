import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import descriptorSchema from "../../schemas/v1/runtime-descriptor.schema.json" with { type: "json" };
import registrySchema from "../../schemas/v1/runtime-process-registry.schema.json" with { type: "json" };
import requestEventSchema from "../../schemas/v1/runtime-request-event.schema.json" with { type: "json" };
import revisionSchema from "../../schemas/v1/runtime-routing-revision.schema.json" with { type: "json" };
import supervisorEventSchema from "../../schemas/v1/runtime-supervisor-event.schema.json" with { type: "json" };
import { LocalReleaseTopology } from "../../src/runtime/local-release-topology.js";
import { RUNTIME_EVENT_TYPES } from "../../src/runtime/request-journal.js";

function lines(text: string): unknown[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function assertValid(validator: ValidateFunction, value: unknown): void {
  assert.equal(validator(value), true, JSON.stringify(validator.errors));
}

test("persisted runtime and inter-process records validate against exact versioned schemas", async (t) => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, formats: { "date-time": true } });
  for (const schema of [revisionSchema, descriptorSchema, registrySchema, requestEventSchema, supervisorEventSchema]) ajv.addSchema(schema);
  const validateRevision = ajv.getSchema(revisionSchema.$id)!;
  const validateDescriptor = ajv.getSchema(descriptorSchema.$id)!;
  const validateRegistry = ajv.getSchema(registrySchema.$id)!;
  const validateRequest = ajv.getSchema(requestEventSchema.$id)!;
  const validateSupervisor = ajv.getSchema(supervisorEventSchema.$id)!;

  const runDirectory = await mkdtemp(join(tmpdir(), "asf-runtime-schema-"));
  const topology = new LocalReleaseTopology({
    factoryRunId: "fr_schema_test",
    runDirectory,
    stableReleaseId: "stable:schema",
    candidateReleaseId: "candidate:schema",
    rolloutSeed: "schema-seed"
  }, { startupDeadlineMs: 8_000, probeIntervalMs: 40, stopGraceMs: 200 });
  t.after(async () => { await topology.cleanup().catch(() => undefined); });
  const snapshot = await topology.start();
  await topology.applyCandidateExposure(2_500);
  await delay(150);

  assertValid(validateRegistry, JSON.parse(await readFile(join(runDirectory, "process-registry.json"), "utf8")));
  for (const instance of snapshot.instances) {
    assertValid(validateDescriptor, JSON.parse(await readFile(instance.runtimeDescriptorPath, "utf8")));
  }
  for (const event of lines(await readFile(join(runDirectory, "supervisor-events.ndjson"), "utf8"))) assertValid(validateSupervisor, event);
  for (const event of lines(await readFile(join(runDirectory, "runtime-events.ndjson"), "utf8"))) assertValid(validateRequest, event);
  const currentRevision = JSON.parse(await readFile(join(runDirectory, "routing-current.json"), "utf8")) as unknown;
  assertValid(validateRevision, currentRevision);
});

test("runtime event schema shares request fields through refs/allOf and cannot drift from event types", () => {
  const schema = requestEventSchema as {
    oneOf: Array<{ $ref: string }>;
    $defs: Record<string, { allOf?: Array<{ $ref?: string }>; properties?: { type?: { const?: string } } }>;
  };
  const requestDefinitions = ["requestStarted", "attemptStarted", "attemptFinished", "protocolFault", "requestFinished"];
  for (const definition of requestDefinitions) {
    const allOf = schema.$defs[definition]?.allOf;
    assert.ok(allOf?.some((item) => item.$ref === "#/$defs/requestBase"), `${definition} does not reuse requestBase`);
  }
  const schemaTypes = schema.oneOf.map((item) => {
    const definition = item.$ref.split("/").at(-1);
    return schema.$defs[definition!]?.properties?.type?.const;
  }).filter((value): value is string => typeof value === "string");
  assert.deepEqual([...schemaTypes].sort(), [...RUNTIME_EVENT_TYPES].sort());
});
