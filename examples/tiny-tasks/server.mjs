import { createServer } from "node:http";
import { TaskStore, taskListRepresentation } from "./app.mjs";
import { writeJsonAtomic } from "./io.mjs";

const dataDirectory = process.env.FACTORY_DATA_DIR;
if (!dataDirectory) throw new Error("FACTORY_DATA_DIR is required");
const instanceId = process.env.FACTORY_INSTANCE_ID ?? "tiny-tasks-local";
const releaseId = process.env.FACTORY_RELEASE_ID ?? "tiny-tasks-development";
const processAttempt = process.env.FACTORY_PROCESS_ATTEMPT ?? "attempt-local";
const ownershipNonce = process.env.FACTORY_OWNERSHIP_NONCE ?? "nonce-local";
const runtimeDescriptorPath = process.env.FACTORY_RUNTIME_DESCRIPTOR;
const requestedPort = Number.parseInt(process.env.PORT ?? "0", 10);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("PORT must be 0..65535");

const store = new TaskStore(dataDirectory);
await store.load();

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function bodyJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("request body exceeds 64 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const identity = { instanceId, releaseId, processAttempt, ownershipNonce };
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && ["/health", "/ready", "/__factory/status"].includes(request.url ?? "")) {
      respond(response, 200, { status: "ok", ready: true, ...identity });
      return;
    }
    if (request.method === "GET" && request.url === "/tasks") {
      respond(response, 200, { ...taskListRepresentation(await store.load()), ...identity });
      return;
    }
    if (request.method === "POST" && request.url === "/tasks") {
      const body = await bodyJson(request);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title.length === 0 || title.length > 200) {
        respond(response, 400, { error: "title must contain 1..200 characters" });
        return;
      }
      respond(response, 201, { task: await store.add(title), ...identity });
      return;
    }
    const deletion = /^\/tasks\/(\d+)$/.exec(request.url ?? "");
    if (request.method === "DELETE" && deletion?.[1] !== undefined) {
      const removed = await store.remove(Number.parseInt(deletion[1], 10));
      respond(response, removed ? 200 : 404, { removed, ...identity });
      return;
    }
    respond(response, 404, { error: "not found", ...identity });
  } catch (error) {
    respond(response, 500, { error: error instanceof Error ? error.message : String(error), ...identity });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(requestedPort, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Tiny Tasks did not bind a TCP endpoint");
const descriptor = { ...identity, pid: process.pid, host: "127.0.0.1", port: address.port };
if (runtimeDescriptorPath) {
  await writeJsonAtomic(runtimeDescriptorPath, descriptor);
}
process.stdout.write(`${JSON.stringify(descriptor)}\n`);

const shutdown = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
