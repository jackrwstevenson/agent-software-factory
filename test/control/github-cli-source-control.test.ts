import assert from "node:assert/strict";
import test from "node:test";

import type { CommandRequest, CommandResult, CommandRunner } from "../../src/control/command-runner.js";
import { GhCliSourceControlGitHub } from "../../src/control/github-cli-source-control.js";
import { parseGitObjectId } from "../../src/protocol/contracts.js";

class ScriptedRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  readonly #results: CommandResult[];

  constructor(results: CommandResult[]) {
    this.#results = results;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("unexpected command");
    return result;
  }
}

const headSha = parseGitObjectId("1234567890abcdef1234567890abcdef12345678");
const pullRequest = JSON.stringify({
  number: 101,
  url: "https://github.org.com/pr/101",
  state: "OPEN",
  isDraft: false,
  headRefName: "factory/issue-41/fr_fixture_001",
  headRefOid: headSha,
  baseRefName: "main",
  mergeCommit: null
});

test("required-check command failures fail closed instead of looking like zero checks", async () => {
  const github = new GhCliSourceControlGitHub({
    runner: new ScriptedRunner([
      { exitCode: 0, stdout: pullRequest, stderr: "" },
      { exitCode: 1, stdout: "", stderr: "authentication failed" }
    ])
  });

  await assert.rejects(
    github.requiredChecksPass({ number: 101, expectedHeadSha: headSha }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "github_blocked_authentication"
  );
});

test("a repository with no required checks is allowed after exact-head revalidation", async () => {
  const github = new GhCliSourceControlGitHub({
    runner: new ScriptedRunner([
      { exitCode: 0, stdout: pullRequest, stderr: "" },
      {
        exitCode: 1,
        stdout: "",
        stderr: "no checks reported on the 'factory/issue-41/fr_fixture_001' branch"
      },
      { exitCode: 0, stdout: pullRequest, stderr: "" }
    ])
  });

  assert.equal(
    await github.requiredChecksPass({ number: 101, expectedHeadSha: headSha }),
    true
  );
});

test("pull-request cleanup closes an open PR and verifies the structured read-back", async () => {
  const closedPullRequest = JSON.stringify({
    ...JSON.parse(pullRequest) as Record<string, unknown>,
    state: "CLOSED"
  });
  const runner = new ScriptedRunner([
    { exitCode: 0, stdout: pullRequest, stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: closedPullRequest, stderr: "" }
  ]);
  const github = new GhCliSourceControlGitHub({ runner });

  const closed = await github.closePullRequest(101);

  assert.equal(closed.state, "closed");
  assert.deepEqual(runner.requests[1]?.args.slice(0, 3), ["pr", "close", "101"]);
});
