import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

import { CodexRoleRuntime } from "../dist/src/roles/runtime.js";
import {
  parseEffectIntentId,
  parseFactoryRunId,
  parseGitObjectId,
  parseIssueId
} from "../dist/src/protocol/contracts.js";

const exec = promisify(execFile);
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const git = async (cwd, ...args) => (await exec("git", args, { cwd, env: { PATH: process.env.PATH } })).stdout.trim();
const emit = (stage, status, detail) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), stage, status, detail })}\n`);

const stateRoot = required("FACTORY_DEMO_STATE_ROOT");
const codexHome = required("FACTORY_CODEX_HOME");
const executablePath = required("FACTORY_CODEX_BIN");
const model = required("FACTORY_CODEX_MODEL");
const providerId = required("FACTORY_CODEX_PROVIDER_ID");
const providerName = required("FACTORY_CODEX_PROVIDER_NAME");
const providerBaseUrl = required("FACTORY_CODEX_PROVIDER_BASE_URL");
const providerWireApi = required("FACTORY_CODEX_PROVIDER_WIRE_API");
const providerEnvironmentKey = required("FACTORY_CODEX_PROVIDER_ENV_KEY");
const factoryRunId = parseFactoryRunId("fr_real_codex_demo");
const worktree = join(stateRoot, "runs", factoryRunId, "worktree");

await rm(stateRoot, { recursive: true, force: true });
await mkdir(worktree, { recursive: true, mode: 0o700 });
await mkdir(codexHome, { recursive: true, mode: 0o700 });
await writeFile(join(worktree, "message.txt"), "Nothing here yet.\n");
await writeFile(join(worktree, "message.test.mjs"), `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\ntest("empty-list copy", async () => assert.equal(await readFile(new URL("./message.txt", import.meta.url), "utf8"), "Nothing here yet.\\n"));\n`);
await git(worktree, "init", "-b", "factory/demo-real-codex");
await git(worktree, "config", "user.name", "Factory Demo");
await git(worktree, "config", "user.email", "factory-demo@example.invalid");
await git(worktree, "add", "message.txt", "message.test.mjs");
await git(worktree, "commit", "-m", "baseline: tiny copy example");
const baseSha = parseGitObjectId(await git(worktree, "rev-parse", "HEAD"));
const executableSha256 = required("FACTORY_CODEX_SHA256");

const runtime = new CodexRoleRuntime({
  executablePath,
  expectedExecutableSha256: executableSha256,
  codexHome,
  stateRoot,
  toolPath: process.env.PATH ?? "/usr/bin:/bin",
  environment: process.env,
  models: { builder: model, verifier: model, reviewer: model },
  provider: {
    id: providerId,
    name: providerName,
    baseUrl: providerBaseUrl,
    wireApi: providerWireApi,
    environmentKey: providerEnvironmentKey,
    requiresOpenAIAuth: false
  },
  builderAllowedPaths: ["message.txt", "message.test.mjs"],
  validationCommands: ["node --test message.test.mjs"],
  forbiddenAuthRoots: [worktree],
  sentinelDeadlineMs: 180_000,
  sentinelCancellationDeadlineMs: 20_000,
  prevalidatedIsolation: {
    outsideRootWritesDenied: true, protectedControlWritesDenied: true, authLocationDenied: true,
    publicNetworkDenied: true, loopbackNetworkDenied: true, privilegedDescriptorsDenied: true,
    unsupportedVerificationWritesDetected: true, cancellationTreeKilled: true
  }
});

emit("preflight", "started", "Verifying pinned CLI, corporate provider, sandbox, secrets, network, and process cancellation");
const preflight = await runtime.preflight();
emit("preflight", "passed", { version: preflight.version, provider: providerName, capabilities: preflight.capabilities });

const issue = {
  issueId: parseIssueId("9001"),
  number: 9001,
  title: "Change the empty-list copy",
  acceptanceCriteria: [
    "Change message.txt from Nothing here yet. to No tasks yet.",
    "Update the regression test to assert No tasks yet.",
    "Do not modify unrelated files."
  ],
  url: "https://example.invalid/issues/9001",
  createdAt: new Date().toISOString()
};
const prepared = {
  factoryRunId,
  branchName: "factory/demo-real-codex",
  branchRef: "refs/heads/factory/demo-real-codex",
  worktreePath: worktree,
  baseSha,
  branchMode: "pure_git"
};

emit("builder", "started", "Launching real Codex Builder with workspace-write sandbox");
const build = await runtime.runBuilder({
  context: { effectIntentId: parseEffectIntentId("fx_real_builder"), factoryRunId },
  issue,
  preparedSource: prepared
});
emit("builder", "passed", { summary: build.summary, stageAttemptId: build.stageAttemptId });

await git(worktree, "add", "message.txt", "message.test.mjs");
await git(worktree, "commit", "-m", "factory: change empty-list copy");
const headCommitSha = parseGitObjectId(await git(worktree, "rev-parse", "HEAD"));
const sourceTreeSha = parseGitObjectId(await git(worktree, "rev-parse", "HEAD^{tree}"));
const candidate = {
  schemaVersion: "1.0",
  contract: "candidate_release",
  factoryRunId,
  candidateOrdinal: 1,
  builderStageAttemptId: build.stageAttemptId,
  branchRef: prepared.branchRef,
  baseSha,
  headCommitSha,
  sourceTreeSha
};
emit("candidate", "created", { headCommitSha, sourceTreeSha, changedFiles: ["message.txt", "message.test.mjs"] });

emit("verifier", "started", "Launching independent real Codex Verifier in read-only sandbox");
const verification = await runtime.runVerifier({
  context: { effectIntentId: parseEffectIntentId("fx_real_verifier"), factoryRunId },
  issue,
  candidate
});
emit("verifier", "passed", { candidateHeadSha: verification.candidateHeadSha, evidenceDigest: verification.evidenceDigest });

emit("reviewer", "started", "Launching independent real Codex Reviewer in read-only sandbox");
const review = await runtime.runReviewer({
  context: { effectIntentId: parseEffectIntentId("fx_real_reviewer"), factoryRunId },
  issue,
  candidate
});
emit("reviewer", "passed", { riskClassification: review.review.riskClassification, evidenceDigest: review.review.evidenceDigest });

const testResult = await exec(process.execPath, ["--test", "message.test.mjs"], { cwd: worktree });
if (!/pass 1/.test(testResult.stdout)) throw new Error("final regression test did not pass");
const finalCopy = (await readFile(join(worktree, "message.txt"), "utf8")).trim();
emit("demo", "succeeded", {
  finalCopy,
  candidateHeadSha: headCommitSha,
  riskClassification: review.review.riskClassification,
  regressionTest: "passed"
});
