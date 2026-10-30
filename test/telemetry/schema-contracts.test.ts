import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import runtimeDescriptorSchema from "../../schemas/v1/runtime-descriptor.schema.json" with { type: "json" };
import incidentStoreSchema from "../../schemas/v1/telemetry-incident-store.schema.json" with { type: "json" };
import eventJournalSchema from "../../schemas/v1/telemetry-event-journal.schema.json" with { type: "json" };
import eventSchema from "../../schemas/v1/telemetry-event.schema.json" with { type: "json" };
import observerResultSchema from "../../schemas/v1/telemetry-observer-result.schema.json" with { type: "json" };
import rolloutProposalSchema from "../../schemas/v1/telemetry-rollout-proposal.schema.json" with { type: "json" };
import summarySchema from "../../schemas/v1/telemetry-window-summary.schema.json" with { type: "json" };
import windowSchema from "../../schemas/v1/telemetry-window.schema.json" with { type: "json" };
import {
  IncidentStore,
  ObserverSession,
  processTelemetryWindow
} from "../../src/telemetry/index.js";
import { populateHealthyWindow, TelemetryRunBuilder } from "./support.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { "date-time": true }
});
for (const schema of [runtimeDescriptorSchema, windowSchema, eventSchema, eventJournalSchema, summarySchema, observerResultSchema, rolloutProposalSchema, incidentStoreSchema]) {
  ajv.addSchema(schema);
}

function validates(schemaId: string, value: unknown): void {
  const validator = ajv.getSchema(schemaId);
  assert.ok(validator, `missing validator ${schemaId}`);
  assert.equal(validator(value), true, JSON.stringify(validator.errors, null, 2));
}

test("telemetry persisted contracts validate against schema-closed v1 schemas", () => {
  const run = new TelemetryRunBuilder("schemas_001");
  const window = populateHealthyWindow(run.createWindow("schemas", "gate_50").open());
  const incidents = new IncidentStore();
  const observer = new ObserverSession("observer-schemas");
  const processed = processTelemetryWindow({
    journal: run.journal,
    windowId: window.binding.windowId,
    incidents,
    observer
  });

  validates(windowSchema.$id, window.binding);
  for (const event of run.journal.snapshot()) validates(eventSchema.$id, event);
  validates(eventJournalSchema.$id, run.journal.checkpoint());
  validates(summarySchema.$id, processed.summary);
  validates(observerResultSchema.$id, processed.observerResult);
  validates(rolloutProposalSchema.$id, processed.proposal);
  validates(incidentStoreSchema.$id, incidents.snapshot());
});

test("telemetry schemas reject hidden authority and unknown envelope fields", () => {
  const run = new TelemetryRunBuilder("schemas_reject_001");
  const window = populateHealthyWindow(run.createWindow("schemas_reject", "gate_50").open());
  const processed = processTelemetryWindow({ journal: run.journal, windowId: window.binding.windowId });
  const validator = ajv.getSchema(observerResultSchema.$id);
  assert.ok(validator);
  assert.equal(validator({ ...processed.observerResult, action: "rollback" }), false);
  assert.match(JSON.stringify(validator.errors), /additionalProperties|action/);
});
