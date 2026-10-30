import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { canonicalJson, canonicalSha256 } from "../../src/protocol/canonical-json.js";
import {
  parseDigest,
  parseEffectIntentId,
  parseFactoryRunId,
  parseGitObjectId,
  parseIssueId,
  parseStageAttemptId,
  type CandidateRelease
} from "../../src/protocol/contracts.js";
import { RoleRuntimeError } from "../../src/roles/errors.js";
import { FactoryRoleRuntime } from "../../src/roles/runtime.js";

type FakeBehavior =
  | "builder_success"
  | "builder_empty"
  | "builder_forbidden"
  | "builder_git_mutates"
  | "environment_probe"
  | "invalid_schema"
  | "missing_completion"
  | "nonzero_exit"
  | "oversized_events"
  | "process_tree"
  | "resolved_evidence"
  | "reviewer_mutates"
  | "reviewer_success"
  | "secret_output"
  | "sentinel_failure"
  | "unresolved_evidence"
  | "verifier_mutates"
  | "verifier_success"
  | "wrong_candidate"
  | "wrong_input"
  | "wrong_version"
  | "not_logged_in";

async function command(cwd: string, executable: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${executable} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

function fakeCodexSource(behavior: FakeBehavior): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(behavior === "wrong_version" ? "codex-cli 0.153.0" : "codex-cli 0.154.0"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") {
  if (behavior === "not_logged_in") { console.error("Not logged in"); process.exit(1); }
  console.log("Logged in"); process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  console.log("--ephemeral --ignore-user-config --strict-config --sandbox --add-dir --model --json --output-schema --output-last-message --color");
  process.exit(0);
}
if (args[0] !== "exec") process.exit(91);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  const sentinelMatch = prompt.match(/<factory-runtime-sentinel>\\n([\\s\\S]*?)\\n<\\/factory-runtime-sentinel>/);
  if (sentinelMatch) {
    const sentinelInput = JSON.parse(sentinelMatch[1]);
    const sentinel = sentinelInput.sentinel;
    const outputIndex = args.indexOf("--output-last-message");
    const output = args[outputIndex + 1];
    if (sentinel === "cancellation") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(sentinelInput.scratch + "/descendant.pid", String(child.pid));
      setInterval(() => {}, 1000);
      return;
    }
    const observations = {};
    if (sentinel === "filesystem") {
      fs.writeFileSync(sentinelInput.workspace + "/allowed.txt", "sentinel allowed write\\n");
      observations.allowed_write_succeeded = true;
      observations.outside_root_denied = true;
      observations.protected_control_denied = true;
    } else if (sentinel === "auth_location") {
      observations.auth_location_denied = true;
    } else if (sentinel === "network") {
      observations.public_network_denied = behavior !== "sentinel_failure";
      observations.loopback_network_denied = true;
    } else if (sentinel === "privileged_descriptors") {
      observations.privileged_descriptor_denied = true;
    } else if (sentinel === "verification_writes") {
      fs.writeFileSync(sentinelInput.scratch + "/verification-scratch.txt", "scratch write\\n");
      observations.source_write_denied = true;
      observations.scratch_write_succeeded = true;
    }
    fs.writeFileSync(output, JSON.stringify({
      schema_version: "1.0",
      contract: "role_runtime_sentinel",
      sentinel,
      passed: behavior !== "sentinel_failure" || sentinel !== "network",
      observations
    }));
    console.log(JSON.stringify({ type: "turn.completed", id: "sentinel." + sentinel }));
    return;
  }
  const inputMatch = prompt.match(/<factory-role-input>\\n([\\s\\S]*?)\\n<\\/factory-role-input>/);
  const digestMatch = prompt.match(/FACTORY_ROLE_INPUT_SHA256=([0-9a-f]{64})/);
  if (!inputMatch || !digestMatch) process.exit(92);
  const input = JSON.parse(inputMatch[1]);
  const outputIndex = args.indexOf("--output-last-message");
  const output = args[outputIndex + 1];
  if (behavior === "process_tree") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.cwd() + "/descendant.pid", String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (behavior === "nonzero_exit") process.exit(17);
  if (behavior === "oversized_events") {
    console.log("x".repeat(128 * 1024));
    setInterval(() => {}, 1000);
    return;
  }
  if (behavior === "verifier_mutates") fs.writeFileSync(process.cwd() + "/product.txt", "mutated by verifier\\n");
  if (behavior === "reviewer_mutates") fs.writeFileSync(process.cwd() + "/product.txt", "mutated by reviewer\\n");
  if (input.role === "builder" && ["builder_success", "environment_probe", "invalid_schema", "missing_completion", "secret_output", "builder_git_mutates", "wrong_input", "resolved_evidence", "unresolved_evidence"].includes(behavior)) {
    fs.writeFileSync(process.cwd() + "/product.txt", "implemented\\n");
  }
  if (behavior === "builder_forbidden") fs.writeFileSync(process.cwd() + "/AGENTS.md", "forbidden\\n");
  if (behavior === "builder_git_mutates") execFileSync("git", ["add", "product.txt"], { cwd: process.cwd() });
  if (behavior === "environment_probe") {
    const joined = args.join("\\n");
    const forbidden = Object.keys(process.env).filter(key => /^(?:OPENAI|GH|GITHUB|SSH|AWS|AZURE|GOOGLE|CODEX_ACCESS_TOKEN)|(?:KEY|SECRET|TOKEN|PASSWORD)$/.test(key));
    const required = [
      "--ephemeral", "--ignore-user-config", "--strict-config", "--add-dir", "--output-schema", "--output-last-message",
      'approval_policy="never"', 'web_search="disabled"', "sandbox_workspace_write.network_access=false", 'shell_environment_policy.inherit="none"'
    ];
    const sandboxIndex = args.indexOf("--sandbox");
    const expectedSandbox = input.role === "builder" ? "workspace-write" : "read-only";
    const scratchIndex = args.indexOf("--add-dir");
    if (forbidden.length > 0 || required.some(value => !joined.includes(value)) || args[sandboxIndex + 1] !== expectedSandbox || scratchIndex < 0) process.exit(93);
    fs.writeFileSync(args[scratchIndex + 1] + "/probe.txt", "scratch is writable\\n");
  }
  if (behavior === "secret_output") console.error("credential=must-not-leak");
  let roleResult;
  let decision;
  let candidateHead = null;
  if (input.role === "builder") {
    decision = "changes_ready";
    const changedPath = behavior === "builder_forbidden" ? "AGENTS.md" : "product.txt";
    roleResult = {
      changed_paths: [changedPath],
      criteria: input.issue.acceptance_criteria.map(criterion => ({ criterion, status: "addressed", evidence_claims: [] })),
      commands: [],
      demonstration_summary: "The requested behaviour is implemented.",
      blocker: null
    };
  } else if (input.role === "verifier") {
    decision = "passed";
    candidateHead = input.source.candidate.head_commit_sha;
    roleResult = {
      checks: input.role_payload.required_commands.map(command => ({ command, status: "passed", evidence_claims: [] })),
      criteria: input.issue.acceptance_criteria.map(criterion => ({ criterion, status: "passed", evidence_claims: [] })),
      findings: [],
      blocker: null
    };
  } else {
    decision = "review_complete";
    candidateHead = input.source.candidate.head_commit_sha;
    roleResult = {
      findings: [],
      correctness_assessment: "complete",
      security_assessment: "complete",
      risk_factors: [],
      risk_classification: "low",
      blocker: null
    };
  }
  const result = {
    schema_version: "1.0",
    contract: "role_result",
    role: input.role,
    factory_run_id: input.factory_run_id,
    stage_attempt_id: input.stage_attempt_id,
    invocation_id: input.invocation_id,
    input_sha256: behavior === "wrong_input" ? "a".repeat(64) : digestMatch[1],
    candidate_head_sha: behavior === "wrong_candidate" ? "f".repeat(40) : candidateHead,
    decision,
    summary: "fake role result",
    evidence_claims: behavior === "resolved_evidence" ? ["event:proof.completed", "fact:source", "artifact:events"] : behavior === "unresolved_evidence" ? ["artifact:missing"] : [],
    unresolved_risks: [],
    role_result: roleResult
  };
  if (behavior === "invalid_schema") result.unexpected_authority = "deploy";
  fs.writeFileSync(output, JSON.stringify(result));
  if (behavior === "resolved_evidence") console.log(JSON.stringify({ type: "item.completed", id: "proof.completed" }));
  console.log(JSON.stringify({ type: behavior === "missing_completion" ? "turn.started" : "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
});
`;
}

async function makeFixture(
  behavior: FakeBehavior,
  overrides: Readonly<{ eventsBytes?: number; expectedExecutableSha256?: string }> = {}
) {
  const root = await mkdtemp(join(tmpdir(), "factory-role-runtime-"));
  const stateRoot = join(root, "state");
  const worktree = join(stateRoot, "runs", "fr_roles_001", "worktree");
  const codexHome = join(root, "factory-codex-home");
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(worktree, "product.txt"), "before\n");
  await command(worktree, "git", ["init", "-q"]);
  await command(worktree, "git", ["config", "user.email", "factory@example.invalid"]);
  await command(worktree, "git", ["config", "user.name", "Factory Test"]);
  await command(worktree, "git", ["add", "product.txt"]);
  await command(worktree, "git", ["commit", "-qm", "baseline"]);
  await command(worktree, "git", ["branch", "-m", "factory/issue-1/fr_roles_001"]);
  const baseSha = await command(worktree, "git", ["rev-parse", "HEAD"]);
  const sourceTreeSha = await command(worktree, "git", ["rev-parse", "HEAD^{tree}"]);
  const branchRef = await command(worktree, "git", ["symbolic-ref", "HEAD"]);
  const executablePath = join(root, "fake-codex");
  const executable = fakeCodexSource(behavior);
  await writeFile(executablePath, executable);
  await chmod(executablePath, 0o755);
  const executableSha256 = createHash("sha256").update(executable).digest("hex");
  const runtime = new FactoryRoleRuntime({
    executablePath,
    expectedExecutableSha256: overrides.expectedExecutableSha256 ?? executableSha256,
    codexHome,
    stateRoot,
    toolPath: process.env.PATH ?? "/usr/bin:/bin",
    environment: {
      ...(process.env as Record<string, string | undefined>),
      GH_TOKEN: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      SENTINEL_SECRET: "must-not-leak"
    },
    models: { builder: "fake-builder", verifier: "fake-verifier", reviewer: "fake-reviewer" },
    builderAllowedPaths: ["product.txt"],
    validationCommands: [],
    cancellation: { interruptGraceMs: 30, terminateGraceMs: 30, killGraceMs: 300 },
    streamLimits: { eventsBytes: overrides.eventsBytes ?? 64 * 1024, stderrBytes: 64 * 1024, resultBytes: 64 * 1024 },
    processInspector: {
      async readBirthIdentity(pid: number) {
        return createHash("sha256").update(`test-process:${pid}`).digest("hex");
      }
    },
    sentinelDeadlineMs: 2_000,
    sentinelCancellationDeadlineMs: 1_500
  });
  return { root, worktree, stateRoot, codexHome, baseSha, sourceTreeSha, branchRef, runtime, executablePath, executableSha256 };
}

function issueInput() {
  return {
    issueId: parseIssueId("issue-1"),
    number: 1,
    title: "Change the product",
    acceptanceCriteria: ["The product file says implemented."],
    url: "https://github.org.com/example/issues/1",
    createdAt: "2026-09-29T08:00:00.000Z"
  };
}

function builderInput(fixture: Awaited<ReturnType<typeof makeFixture>>, effect = "fx_builder_001") {
  return {
    context: {
      effectIntentId: parseEffectIntentId(effect),
      factoryRunId: parseFactoryRunId("fr_roles_001")
    },
    issue: issueInput(),
    preparedSource: {
      factoryRunId: parseFactoryRunId("fr_roles_001"),
      branchName: "factory/issue-1/fr_roles_001",
      branchRef: fixture.branchRef,
      worktreePath: fixture.worktree,
      baseSha: parseGitObjectId(fixture.baseSha),
      branchMode: "pure_git" as const
    }
  };
}

function candidate(fixture: Awaited<ReturnType<typeof makeFixture>>): CandidateRelease {
  return {
    schemaVersion: "1.0",
    contract: "candidate_release",
    factoryRunId: parseFactoryRunId("fr_roles_001"),
    candidateOrdinal: 1,
    builderStageAttemptId: parseStageAttemptId("fa_builder_source"),
    branchRef: fixture.branchRef,
    baseSha: parseGitObjectId(fixture.baseSha),
    headCommitSha: parseGitObjectId(fixture.baseSha),
    sourceTreeSha: parseGitObjectId(fixture.sourceTreeSha)
  };
}

function analyticalRequest(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  role: "verifier" | "reviewer",
  attempt: string
) {
  const exactCandidate = candidate(fixture);
  return {
    role,
    factoryRunId: parseFactoryRunId("fr_roles_001"),
    stageAttemptId: parseStageAttemptId(attempt),
    invocationId: `ri_${attempt.slice(3)}`,
    lifecycleState: role === "verifier" ? "verifying" as const : "reviewing" as const,
    stageAttemptOrdinal: 1,
    issue: {
      issue_id: "issue-1",
      number: 1,
      title: "Change the product",
      acceptance_criteria: ["The product file says implemented."],
      url: "https://github.org.com/example/issues/1",
      created_at: "2026-09-29T08:00:00.000Z"
    },
    worktreePath: fixture.worktree,
    branchRef: fixture.branchRef,
    baseSha: parseGitObjectId(fixture.baseSha),
    candidate: exactCandidate,
    instructions: [role === "verifier" ? "Verify." : "Review."],
    policyRefs: [],
    priorHandoffs: [],
    rolePayload: role === "verifier"
      ? { required_commands: [], changed_paths: [], diff_sha256: canonicalSha256(exactCandidate) }
      : {
          changed_paths: [],
          diff_sha256: canonicalSha256(exactCandidate),
          risk_policy_id: "risk-policy/v1",
          risk_policy_sha256: parseDigest("0".repeat(64))
        }
  };
}

async function rejectsWithCode(action: () => Promise<unknown>, code: RoleRuntimeError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof RoleRuntimeError);
    assert.equal(error.code, code);
    return true;
  });
}

test("Builder executes through the pinned isolated wrapper and records an accepted canonical result", async () => {
  const fixture = await makeFixture("builder_success");
  try {
    const preflight = await fixture.runtime.preflight();
    assert.equal(preflight.version, "codex-cli 0.154.0");
    assert.equal(preflight.authenticated, true);
    assert.equal(preflight.capabilities.commandNetworkDenied, true);
    assert.equal(preflight.capabilities.commandLoopbackDenied, true);
    assert.equal(preflight.capabilities.outsideRootWritesDenied, true);
    assert.equal(preflight.capabilities.protectedControlWritesDenied, true);
    assert.equal(preflight.capabilities.authLocationDenied, true);
    assert.equal(preflight.capabilities.privilegedDescriptorsDenied, true);
    assert.equal(preflight.capabilities.unsupportedVerificationWritesDetected, true);
    assert.equal(preflight.capabilities.cancellationTreeKilled, true);
    assert.deepEqual(
      (await readdir(join(fixture.stateRoot, "control", "role-runtime-preflight", "sentinels"))).sort(),
      ["auth_location", "cancellation", "filesystem", "network", "privileged_descriptors", "verification_writes"]
    );

    const result = await fixture.runtime.runBuilder(builderInput(fixture));
    assert.equal(result.decision, "changes_ready");
    assert.equal(result.summary, "fake role result");
    assert.equal(await readFile(join(fixture.worktree, "product.txt"), "utf8"), "implemented\n");

    const acceptedPath = join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_builder_001", "accepted-result.json");
    const accepted = JSON.parse(await readFile(acceptedPath, "utf8")) as { result: { input_sha256: string } };
    assert.match(accepted.result.input_sha256, /^[0-9a-f]{64}$/);
    const input = await readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_builder_001", "input.json"), "utf8");
    assert.equal(input.trim(), canonicalJson(JSON.parse(input) as unknown));
    assert.equal((await stat(acceptedPath)).mode & 0o077, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preflight rejects an unpinned executable digest, wrong version, missing auth, and symlink entrypoint", async (t) => {
  await t.test("digest mismatch", async () => {
    const fixture = await makeFixture("builder_success", { expectedExecutableSha256: "0".repeat(64) });
    try { await rejectsWithCode(() => fixture.runtime.preflight(), "worker_protocol_error"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("version mismatch", async () => {
    const fixture = await makeFixture("wrong_version");
    try { await rejectsWithCode(() => fixture.runtime.preflight(), "worker_protocol_error"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("authentication missing", async () => {
    const fixture = await makeFixture("not_logged_in");
    try { await rejectsWithCode(() => fixture.runtime.preflight(), "worker_protocol_error"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("failed observed isolation sentinel", async () => {
    const fixture = await makeFixture("sentinel_failure");
    try { await rejectsWithCode(() => fixture.runtime.preflight(), "worker_protocol_error"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("mutable symlink entrypoint", async () => {
    const fixture = await makeFixture("builder_success");
    try {
      const link = join(fixture.root, "codex-current");
      await symlink(fixture.executablePath, link);
      const runtime = new FactoryRoleRuntime({
        executablePath: link,
        expectedExecutableSha256: fixture.executableSha256,
        codexHome: fixture.codexHome,
        stateRoot: fixture.stateRoot,
        toolPath: process.env.PATH ?? "/usr/bin:/bin",
        models: { builder: "fake", verifier: "fake", reviewer: "fake" }
      });
      await rejectsWithCode(() => runtime.preflight(), "worker_protocol_error");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("roles receive minimal environments, explicit network denial, role sandboxes, and isolated writable scratch", async (t) => {
  await t.test("Builder workspace-write", async () => {
    const fixture = await makeFixture("environment_probe");
    try {
      await fixture.runtime.runBuilder(builderInput(fixture));
      assert.equal(await readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_builder_001", "scratch", "probe.txt"), "utf8"), "scratch is writable\n");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("Verifier read-only plus scratch", async () => {
    const fixture = await makeFixture("environment_probe");
    try {
      await fixture.runtime.runRole(analyticalRequest(fixture, "verifier", "fa_verify_env"));
      assert.equal(await readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_verify_env", "scratch", "probe.txt"), "utf8"), "scratch is writable\n");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("every Evidence Claim must resolve to a captured event, authoritative fact, or retained artifact", async (t) => {
  await t.test("resolved claims", async () => {
    const fixture = await makeFixture("resolved_evidence");
    try {
      const result = await fixture.runtime.runBuilder(builderInput(fixture));
      assert.equal(result.decision, "changes_ready");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("unresolved claim", async () => {
    const fixture = await makeFixture("unresolved_evidence");
    try {
      await rejectsWithCode(() => fixture.runtime.runBuilder(builderInput(fixture)), "worker_protocol_error");
      await assert.rejects(readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_builder_001", "accepted-result.json")));
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("known secret literals are redacted from retained evidence", async () => {
  const fixture = await makeFixture("secret_output");
  try {
    await fixture.runtime.runBuilder(builderInput(fixture));
    const stderr = await readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_builder_001", "stderr.log"), "utf8");
    assert.doesNotMatch(stderr, /must-not-leak/);
    assert.match(stderr, /\[REDACTED\]/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schema-invalid and incomplete Codex results fail closed without accepted-result.json", async (t) => {
  for (const [behavior, code] of [["invalid_schema", "schema_invalid"], ["wrong_input", "identity_mismatch"], ["missing_completion", "missing_turn_completion"], ["nonzero_exit", "nonzero_exit"]] as const) {
    await t.test(behavior, async () => {
      const fixture = await makeFixture(behavior);
      try {
        await rejectsWithCode(() => fixture.runtime.runBuilder(builderInput(fixture)), code);
        await assert.rejects(readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_builder_001", "accepted-result.json")));
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
  }
});

test("Builder postconditions reject empty, forbidden, and Git-index mutations", async (t) => {
  for (const [behavior, code] of [["builder_empty", "worktree_not_clean"], ["builder_forbidden", "forbidden_path_change"], ["builder_git_mutates", "unauthorized_write"]] as const) {
    await t.test(behavior, async () => {
      const fixture = await makeFixture(behavior);
      try { await rejectsWithCode(() => fixture.runtime.runBuilder(builderInput(fixture)), code); }
      finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
  }
});

test("dirty, noncanonical, and non-run-bound checkouts are rejected before a Stage Attempt exists", async (t) => {
  await t.test("dirty checkout", async () => {
    const fixture = await makeFixture("builder_success");
    try {
      await writeFile(join(fixture.worktree, "product.txt"), "dirty before attempt\n");
      await rejectsWithCode(() => fixture.runtime.runBuilder(builderInput(fixture, "fx_dirty_001")), "worktree_not_clean");
      await assert.rejects(stat(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_dirty_001")));
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  await t.test("non-run-bound checkout", async () => {
    const fixture = await makeFixture("builder_success");
    try {
      const outside = join(fixture.root, "outside-worktree");
      await command(fixture.root, "git", ["clone", "-q", fixture.worktree, outside]);
      const input = builderInput(fixture, "fx_outside_001");
      await rejectsWithCode(() => fixture.runtime.runBuilder({
        ...input,
        preparedSource: { ...input.preparedSource, worktreePath: outside }
      }), "candidate_mismatch");
      await assert.rejects(stat(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_outside_001")));
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("Builder input identity is exact and a completed Stage Attempt cannot be overwritten", async () => {
  const fixture = await makeFixture("builder_success");
  try {
    const staleBase = {
      ...builderInput(fixture, "fx_builder_stale"),
      preparedSource: {
        ...builderInput(fixture, "fx_builder_stale").preparedSource,
        baseSha: parseGitObjectId("f".repeat(40))
      }
    };
    await rejectsWithCode(() => fixture.runtime.runBuilder(staleBase), "candidate_mismatch");

    await fixture.runtime.runBuilder(builderInput(fixture));
    await command(fixture.worktree, "git", ["checkout", "--", "product.txt"]);
    await rejectsWithCode(() => fixture.runtime.runBuilder(builderInput(fixture)), "stale_input");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Verifier and Reviewer run read-only with exact Candidate binding and mutation postconditions", async (t) => {
  await t.test("Verifier accepts an unchanged exact Candidate", async () => {
    const fixture = await makeFixture("verifier_success");
    try {
      const accepted = await fixture.runtime.runRole(analyticalRequest(fixture, "verifier", "fa_verify_001"));
      assert.equal(accepted.result.decision, "passed");
      assert.equal(accepted.postconditions.source_tree_unchanged, true);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("Reviewer accepts an unchanged exact Candidate and records Low classification", async () => {
    const fixture = await makeFixture("reviewer_success");
    try {
      const accepted = await fixture.runtime.runRole(analyticalRequest(fixture, "reviewer", "fa_review_success"));
      assert.equal(accepted.result.decision, "review_complete");
      assert.equal(accepted.result.role_result.risk_classification, "low");
      assert.equal(accepted.postconditions.source_tree_unchanged, true);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("Verifier mutation", async () => {
    const fixture = await makeFixture("verifier_mutates");
    try { await rejectsWithCode(() => fixture.runtime.runRole(analyticalRequest(fixture, "verifier", "fa_verify_002")), "unauthorized_write"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("Reviewer mutation", async () => {
    const fixture = await makeFixture("reviewer_mutates");
    try { await rejectsWithCode(() => fixture.runtime.runRole(analyticalRequest(fixture, "reviewer", "fa_review_001")), "unauthorized_write"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("stale result Candidate", async () => {
    const fixture = await makeFixture("wrong_candidate");
    try { await rejectsWithCode(() => fixture.runtime.runRole(analyticalRequest(fixture, "verifier", "fa_verify_003")), "candidate_mismatch"); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("monotonic timeout cancels the POSIX process group and proves no descendant survives", async () => {
  const fixture = await makeFixture("process_tree");
  try {
    const request = { ...analyticalRequest(fixture, "verifier", "fa_verify_timeout"), wallClockLimitMs: 100 };
    await rejectsWithCode(() => fixture.runtime.runRole(request), "timed_out");
    const descendantPid = Number(await readFile(join(fixture.worktree, "descendant.pid"), "utf8"));
    const state = await command(fixture.worktree, "ps", ["-o", "stat=", "-p", String(descendantPid)]).catch(() => "");
    assert.ok(state === "" || state.startsWith("Z"), `descendant still running with state ${state}`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded JSONL evidence cancels the process tree and can never be accepted", async () => {
  const fixture = await makeFixture("oversized_events", { eventsBytes: 1024 });
  try {
    await rejectsWithCode(
      () => fixture.runtime.runRole({ ...analyticalRequest(fixture, "verifier", "fa_verify_limit"), wallClockLimitMs: 2_000 }),
      "evidence_limit_exceeded"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Stage Attempt start intent and live process identity are durable before waiting for role completion", async () => {
  const fixture = await makeFixture("process_tree");
  try {
    const action = fixture.runtime.runRole({
      ...analyticalRequest(fixture, "verifier", "fa_verify_durable_start"),
      wallClockLimitMs: 1_000
    });
    const directory = join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_verify_durable_start");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const intent = JSON.parse(await readFile(join(directory, "start-intent.json"), "utf8")) as { contract: string };
        const live = JSON.parse(await readFile(join(directory, "process-live.json"), "utf8")) as { pid: number; pgid: number; birth_identity: string };
        assert.equal(intent.contract, "role_start_intent");
        assert.equal(live.pid, live.pgid);
        assert.match(live.birth_identity, /^[0-9a-f]{64}$/);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(Date.now() < deadline, "live process record was not persisted while the role was running");
    await rejectsWithCode(() => action, "timed_out");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy RoleRuntime adapters create and consume Candidate-bound Handoffs with actual Git diff facts", async () => {
  const fixture = await makeFixture("builder_success");
  try {
    const build = await fixture.runtime.runBuilder(builderInput(fixture, "fx_builder_legacy"));
    await command(fixture.worktree, "git", ["add", "product.txt"]);
    await command(fixture.worktree, "git", ["commit", "-qm", "Candidate"]);
    const head = await command(fixture.worktree, "git", ["rev-parse", "HEAD"]);
    const tree = await command(fixture.worktree, "git", ["rev-parse", "HEAD^{tree}"]);
    const exactCandidate: CandidateRelease = {
      schemaVersion: "1.0",
      contract: "candidate_release",
      factoryRunId: parseFactoryRunId("fr_roles_001"),
      candidateOrdinal: 1,
      builderStageAttemptId: build.stageAttemptId,
      branchRef: fixture.branchRef,
      baseSha: parseGitObjectId(fixture.baseSha),
      headCommitSha: parseGitObjectId(head),
      sourceTreeSha: parseGitObjectId(tree)
    };
    const issue = issueInput();
    await fixture.runtime.runVerifier({
      context: { effectIntentId: parseEffectIntentId("fx_verify_legacy"), factoryRunId: parseFactoryRunId("fr_roles_001") },
      issue,
      candidate: exactCandidate
    });
    await fixture.runtime.runReviewer({
      context: { effectIntentId: parseEffectIntentId("fx_review_legacy"), factoryRunId: parseFactoryRunId("fr_roles_001") },
      issue,
      candidate: exactCandidate
    });

    const verifierInput = JSON.parse(await readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_verify_legacy", "input.json"), "utf8")) as {
      role_payload: { changed_paths: string[]; diff_sha256: string };
      prior_handoffs: Array<{ kind: string; candidate: { head_commit_sha: string; source_tree_sha: string } }>;
    };
    assert.deepEqual(verifierInput.role_payload.changed_paths, ["product.txt"]);
    assert.match(verifierInput.role_payload.diff_sha256, /^[0-9a-f]{64}$/);
    assert.equal(verifierInput.prior_handoffs[0]?.kind, "builder_to_verifier");
    assert.equal(verifierInput.prior_handoffs[0]?.candidate.head_commit_sha, head);
    assert.equal(verifierInput.prior_handoffs[0]?.candidate.source_tree_sha, tree);

    const reviewerInput = JSON.parse(await readFile(join(fixture.stateRoot, "runs", "fr_roles_001", "attempts", "fa_review_legacy", "input.json"), "utf8")) as {
      role_payload: { changed_paths: string[]; diff_sha256: string };
      prior_handoffs: Array<{ kind: string; downstream: string }>;
    };
    assert.deepEqual(reviewerInput.role_payload.changed_paths, ["product.txt"]);
    assert.equal(reviewerInput.role_payload.diff_sha256, verifierInput.role_payload.diff_sha256);
    assert.deepEqual(reviewerInput.prior_handoffs.map((handoff) => [handoff.kind, handoff.downstream]), [["verifier_to_reviewer", "reviewer"]]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
