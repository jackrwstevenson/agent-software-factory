import type { ObserverInput } from "./observer.js";
import type { BabysitterWorkerInput } from "./worker-protocol.js";
import { invokeBabysitterWorker, invokeObserverWorker } from "./worker-protocol.js";

async function main(): Promise<void> {
  const role = process.argv[2];
  let encoded = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) encoded += chunk;
  const input = JSON.parse(encoded) as unknown;
  const output = role === "observer"
    ? invokeObserverWorker(input as ObserverInput)
    : role === "rollout_babysitter"
      ? invokeBabysitterWorker(input as BabysitterWorkerInput)
      : (() => { throw new Error(`unknown telemetry worker role ${String(role)}`); })();
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
