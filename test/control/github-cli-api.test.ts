import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GhCliGitHubApi
} from "../../src/control/github-cli-api.js";
import { FileConditionalPollStore } from "../../src/control/conditional-poll-store.js";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner
} from "../../src/control/command-runner.js";

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

test("ready-issue polling persists and reuses the Enterprise ETag", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "factory-etag-"));
  try {
    const issue = {
      number: 41,
      title: "Oldest issue",
      body: "- [ ] acceptance",
      created_at: "2026-09-28T08:00:00.000Z",
      updated_at: "2026-09-28T08:00:00.000Z",
      state: "open",
      html_url: "https://github.org.com/issues/41",
      labels: [{ name: "factory:ready" }],
      assignees: []
    };
    const runner = new ScriptedRunner([
      {
        exitCode: 0,
        stderr: "",
        stdout: `HTTP/1.1 200 OK\nETag: \"ready-v1\"\n\n${JSON.stringify([issue])}`
      },
      {
        exitCode: 0,
        stderr: "",
        stdout: "HTTP/1.1 304 Not Modified\nETag: \"ready-v1\"\n\n"
      }
    ]);
    const api = new GhCliGitHubApi({
      runner,
      pollStore: new FileConditionalPollStore(join(stateRoot, "poll.json"))
    });

    const first = await api.listReadyIssues();
    const second = await api.listReadyIssues();

    assert.equal(first[0]?.number, 41);
    assert.deepEqual(second, []);
    assert.ok(runner.requests[1]?.args.includes("If-None-Match: \"ready-v1\""));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("comment and status reconciliation reads every paginated result", async () => {
  const sha = "1234567890abcdef1234567890abcdef12345678" as import("../../src/protocol/contracts.js").GitObjectId;
  const runner = new ScriptedRunner([
    {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify([
        [{ id: 1, body: "one", html_url: "https://github.org.com/comment/1" }],
        [{ id: 2, body: "two", html_url: "https://github.org.com/comment/2" }]
      ])
    },
    {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify([
        [{ id: 10, sha, context: "factory/verifier", state: "success", description: "one", target_url: "https://github.org.com/comment/1", url: "https://api/status/10" }],
        [{ id: 11, sha, context: "factory/review", state: "success", description: "two", target_url: "https://github.org.com/comment/2", url: "https://api/status/11" }]
      ])
    }
  ]);
  const api = new GhCliGitHubApi({ runner });

  assert.equal((await api.listIssueComments(41)).length, 2);
  assert.equal((await api.listCommitStatuses(sha)).length, 2);
  assert.ok(runner.requests.every((request) => request.args.includes("--paginate")));
  assert.ok(runner.requests.every((request) => request.args.includes("--slurp")));
});

test("terminal issue projection sends the exact labels, assignees, and issue state", async () => {
  const issue = {
    number: 41,
    title: "Terminal issue",
    body: "",
    created_at: "2026-09-28T08:00:00.000Z",
    updated_at: "2026-09-29T08:00:00.000Z",
    state: "closed",
    html_url: "https://github.org.com/issues/41",
    labels: [{ name: "bug" }, { name: "factory:succeeded" }],
    assignees: [{ login: "GH_ENTERPRISE_USERNAME" }]
  };
  const runner = new ScriptedRunner([
    { exitCode: 0, stderr: "", stdout: JSON.stringify(issue) }
  ]);
  const api = new GhCliGitHubApi({ runner });

  const updated = await api.updateIssueProjection({
    issueNumber: 41,
    labels: ["bug", "factory:succeeded"],
    assignees: ["GH_ENTERPRISE_USERNAME"],
    state: "closed"
  });

  assert.equal(updated.state, "closed");
  assert.equal(
    runner.requests[0]?.stdin,
    '{"assignees":["GH_ENTERPRISE_USERNAME"],"labels":["bug","factory:succeeded"],"state":"closed"}'
  );
});
