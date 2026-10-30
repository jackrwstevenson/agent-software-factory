import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseProcessChildSpec } from "./child-spec.js";
import { atomicWriteJson } from "./runtime-files.js";
import { readProcessBirthIdentity } from "./process-identity.js";
import { FileRuntimeEventJournal } from "./request-journal.js";
import { createRouter, createSyntheticUsers } from "./routing.js";
import {
  assertRoutingRevisionSelfConsistent,
  assertRoutingRevisionTransition,
  createRoutingRevision,
  type RoutingRevision
} from "./routing-revision.js";
import type { RuntimeDescriptor, RuntimeStatus } from "./runtime-contracts.js";
import { UnavailableError, runLogicalRequest } from "./synthetic-traffic.js";

const raw = process.env.FACTORY_CHILD_SPEC_JSON;
if (!raw) throw new Error("FACTORY_CHILD_SPEC_JSON is required");
const spec = parseProcessChildSpec(JSON.parse(raw) as unknown);
let lifecycleState: "ready" | "draining" = "ready";
let port = 0;
let readyAt = "";
let birthIdentity = "";
let details: Record<string, unknown> = {};
let routingRevision: RoutingRevision | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let trafficTimer: NodeJS.Timeout | null = null;
let requestCounter = 0;
let inFlight = 0;
let trafficStats = { total: 0, stable: 0, candidate: 0, errors: 0 };
let trafficPaused = false;
let journal: FileRuntimeEventJournal | null = null;

function status(): RuntimeStatus {
  return {
    protocolVersion: "runtime-status/v1",
    factoryRunId: spec.factoryRunId,
    instanceId: spec.instanceId,
    processAttempt: spec.processAttempt,
    processKind: spec.processKind,
    releaseId: spec.releaseId,
    ownershipNonce: spec.ownershipNonce,
    pid: process.pid,
    processBirthIdentity: birthIdentity,
    port,
    lifecycleState,
    details
  };
}

async function persistDescriptor(): Promise<void> {
  const descriptor: RuntimeDescriptor = {
    schemaVersion: "1.0",
    contract: "runtime_descriptor",
    ...status(),
    endpoint: `http://127.0.0.1:${port}`,
    readyAt
  };
  await atomicWriteJson(spec.runtimeDescriptorPath, descriptor);
}

function json(response: ServerResponse, code: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1_000) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function loadRevision(): Promise<RoutingRevision> {
  if (spec.processKind !== "router") throw new Error("only Router loads routing revisions");
  return JSON.parse(await readFile(spec.routingCurrentPath, "utf8")) as RoutingRevision;
}

async function refreshRouting(): Promise<void> {
  const next = await loadRevision();
  if (next.factoryRunId !== spec.factoryRunId) throw new Error("routing revision belongs to another Factory Run");
  if (routingRevision?.fullFingerprint === next.fullFingerprint) return;
  assertRoutingRevisionSelfConsistent(next);
  if (routingRevision) assertRoutingRevisionTransition(routingRevision, next);
  const recomputed = createRoutingRevision({
    revision: next.revision,
    reason: next.reason,
    priorRevision: next.priorRevision,
    factoryRunId: next.factoryRunId,
    rolloutSeed: next.rolloutSeed,
    stable: next.stable,
    candidate: next.candidate,
    candidateBasisPoints: next.candidateBasisPoints,
    workload: next.workload
  });
  if (recomputed.fullFingerprint !== next.fullFingerprint) throw new Error("routing full fingerprint mismatch");
  routingRevision = next;
  details = {
    appliedRoutingRevision: next.revision,
    appliedRoutingFullFingerprint: next.fullFingerprint,
    configFingerprint: next.configFingerprint,
    candidateBasisPoints: next.candidateBasisPoints,
    stable: next.stable,
    candidate: next.candidate
  };
  if (port > 0) await persistDescriptor();
}

async function dispatchToRelease(
  endpoint: string
): Promise<{ releaseId: string; processAttempt: number; statusCode: number }> {
  try {
    const result = await getJson(`${endpoint}/work`);
    return {
      releaseId: String(result.body.releaseId ?? ""),
      processAttempt: Number(result.body.processAttempt),
      statusCode: result.status
    };
  } catch (error) {
    throw new UnavailableError(error instanceof Error ? error.message : String(error));
  }
}

async function handleRouterRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (spec.processKind !== "router" || !routingRevision || !journal) throw new Error("router is not initialized");
  const activeRevision = routingRevision;
  const input = await bodyJson(request);
  const requestId = String(input.requestId ?? "");
  const userId = String(input.userId ?? "");
  const maxAttempts = Number(input.maxAttempts ?? 3);
  const router = createRouter({
    algorithmId: activeRevision.algorithmId,
    factoryRunId: activeRevision.factoryRunId,
    rolloutSeed: activeRevision.rolloutSeed,
    stableReleaseId: activeRevision.stable.releaseId,
    candidateReleaseId: activeRevision.candidate.releaseId,
    candidateBasisPoints: activeRevision.candidateBasisPoints
  });
  const decision = router.decide(userId);
  const target = decision.target === "candidate" ? activeRevision.candidate : activeRevision.stable;
  const result = await runLogicalRequest({
    router,
    journal,
    requestId,
    userId,
    maxAttempts,
    expectedProcessAttempt: target.processAttempt,
    binding: {
      routingRevision: activeRevision.revision,
      routingFullFingerprint: activeRevision.fullFingerprint,
      workloadVersion: activeRevision.workload.version,
      workloadUsersDigest: activeRevision.workload.usersDigest
    },
    dispatch: async () => dispatchToRelease(target.endpoint)
  });
  json(response, result.outcome === "success" ? 200 : 503, {
    requestId,
    outcome: result.outcome,
    attempts: result.attempts,
    target: result.assignment.target,
    releaseId: result.assignment.releaseId,
    processAttempt: target.processAttempt,
    routingRevision: activeRevision.revision,
    routingFullFingerprint: activeRevision.fullFingerprint
  });
}

async function issueTraffic(): Promise<void> {
  if (spec.processKind !== "synthetic_traffic" || trafficPaused || inFlight >= 8 || lifecycleState !== "ready") return;
  const users = createSyntheticUsers();
  const userId = users[requestCounter % users.length];
  if (!userId) return;
  const requestId = `synthetic-${spec.processAttempt}-${requestCounter}`;
  requestCounter += 1;
  inFlight += 1;
  try {
    const result = await getJson(`${spec.routerEndpoint}/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, userId, maxAttempts: 3 })
    });
    trafficStats.total += 1;
    if (result.body.target === "candidate") trafficStats.candidate += 1;
    else if (result.body.target === "stable") trafficStats.stable += 1;
    if (result.status >= 400) trafficStats.errors += 1;
  } catch {
    trafficStats.total += 1;
    trafficStats.errors += 1;
  } finally {
    inFlight -= 1;
    details = { routerEndpoint: spec.routerEndpoint, paused: trafficPaused, inFlight, stats: trafficStats };
  }
}

async function main(): Promise<void> {
  birthIdentity = await readProcessBirthIdentity(process.pid);
  if (spec.processKind === "router") {
    journal = await FileRuntimeEventJournal.open(spec.runtimeEventJournalPath);
    await refreshRouting();
  } else if (spec.processKind === "synthetic_traffic") {
    details = { routerEndpoint: spec.routerEndpoint, paused: trafficPaused, inFlight, stats: trafficStats };
  } else {
    details = { releaseId: spec.releaseId, processAttempt: spec.processAttempt };
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/__factory/status") {
        json(response, 200, status());
        return;
      }
      if (request.method === "GET" && request.url === "/work" && spec.processKind.endsWith("_release")) {
        json(response, 200, { releaseId: spec.releaseId, processAttempt: spec.processAttempt, instanceId: spec.instanceId });
        return;
      }
      if (request.method === "POST" && request.url === "/__factory/pause" && spec.processKind === "synthetic_traffic") {
        trafficPaused = true;
        details = { routerEndpoint: spec.routerEndpoint, paused: trafficPaused, inFlight, stats: trafficStats };
        await persistDescriptor();
        json(response, 200, { paused: true });
        return;
      }
      if (request.method === "POST" && request.url === "/__factory/resume" && spec.processKind === "synthetic_traffic") {
        trafficPaused = false;
        details = { routerEndpoint: spec.routerEndpoint, paused: trafficPaused, inFlight, stats: trafficStats };
        await persistDescriptor();
        json(response, 200, { paused: false });
        return;
      }
      if (request.method === "POST" && request.url === "/request" && spec.processKind === "router") {
        await handleRouterRequest(request, response);
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch((error: unknown) => json(response, 502, { error: error instanceof Error ? error.message : String(error) }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("child did not bind an IP port");
  port = address.port;
  readyAt = new Date().toISOString();
  await persistDescriptor();
  process.stdout.write(`${JSON.stringify({ at: readyAt, event: "ready", ...status() })}\n`);

  if (spec.processKind === "router") {
    refreshTimer = setInterval(() => { void refreshRouting().catch((error: unknown) => process.stderr.write(`${String(error)}\n`)); }, 40);
  }
  if (spec.processKind === "synthetic_traffic") trafficTimer = setInterval(() => { void issueTraffic(); }, 20);

  process.on("SIGTERM", () => {
    if (spec.ignoreSigterm) {
      process.stderr.write(`${spec.instanceId} intentionally ignored SIGTERM\n`);
      return;
    }
    if (lifecycleState === "draining") return;
    lifecycleState = "draining";
    if (refreshTimer) clearInterval(refreshTimer);
    if (trafficTimer) clearInterval(trafficTimer);
    void persistDescriptor().catch(() => undefined);
    server.close(() => process.exit(0));
    void delay(500).then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
