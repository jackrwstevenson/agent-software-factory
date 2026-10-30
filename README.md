# Local Agentic Software Factory

A deliberately small, locally runnable proof of an auditable software-delivery loop. The factory takes one GitHub issue through implementation, independent verification, review, risk-based authorization, progressive rollout, and observation on a single developer machine.

The design keeps durable workflow state local while projecting human-visible status to GitHub through labels, comments, pull requests, and commit statuses.

> [!IMPORTANT]
> This repository is an experimental, repository-specific V1—not a general CI/CD platform. The `fixture` scenario is the safest way to explore the complete workflow. The `phase2` scenario uses real GitHub and Git control adapters, is pinned to this repository's enterprise environment, and can mutate issues, branches, pull requests, and the default branch.

## Workflow

```text
GitHub issue
    │
    ▼
 Build ──► Verify ──► Review ──► Authorize ──► Rollout ──► Observe
    ▲          │          │           │             │
    └── repair ┘          │           │             └── rollback on unsafe evidence
                          │           ├── Low risk: autonomous authorization
                          │           ├── Elevated risk: human authorization
                          │           └── Prohibited: reject
                          └── Candidate-bound findings and evidence
```

A single **Factory Run** owns the issue and advances an immutable **Candidate Release** through six gated stages:

1. **Build** — the Builder changes product source in an isolated Factory Worktree.
2. **Verify** — the Verifier independently builds and tests the exact Candidate Release.
3. **Review** — the Reviewer evaluates correctness, security, operations, reversibility, and scope.
4. **Authorize** — policy autonomously authorizes Low risk, waits for a human on Elevated risk, and rejects Prohibited changes.
5. **Rollout** — deterministic synthetic traffic moves through staging and progressive exposure gates.
6. **Observe** — telemetry and incidents are evaluated before exact-tree integration and terminal cleanup.

See [CONTEXT.md](CONTEXT.md) for the canonical domain vocabulary and invariants.

## What is implemented

- A single-writer Factory Run state machine with explicit legal transitions and terminal outcomes.
- Append-only, digest-chained run journals with replayable snapshots and durable effect intents.
- JSON Schema-validated contracts under [`schemas/v1`](schemas/v1).
- Recoverable GitHub claim and projection logic using the GitHub CLI and REST/GraphQL APIs.
- Isolated Factory Branch and Factory Worktree lifecycle management with exact-SHA checks.
- Fresh, supervised role processes with role-specific filesystem and network policies.
- Candidate-bound Builder, Verifier, Reviewer, and handoff contracts.
- Local release process supervision, identity-aware health checks, deterministic routing, and synthetic traffic.
- A fixed progressive rollout ladder: staging, stable reference, 5%, 10%, 30%, 50%, 80%, then 100% observation.
- Deterministic telemetry reduction, incident tracking, fail-closed rollout decisions, and replay tests.
- A minimal **Tiny Tasks** service used as the executable rollout acceptance slice.

## Requirements

For local development and the fixture scenario:

- Node.js **24.16.0**
- npm

The live control-plane scenario additionally pins:

- Git **2.47.1**
- GitHub CLI **2.96.0**
- GitHub Enterprise Server **3.19.10**
- A POSIX environment with loopback networking and process-group signals

The exact live GitHub host, repository, account, remote URL, and tool versions are currently configured in [`src/control/config.ts`](src/control/config.ts) and [`src/control/phase2-adapters.ts`](src/control/phase2-adapters.ts).

## Quick start

Install dependencies, build the TypeScript sources, and run the fully deterministic fixture:

```bash
npm ci
npm run build

STATE_ROOT="$(mktemp -d)"
node dist/src/cli.js run-once \
  --scenario fixture \
  --state-root "$STATE_ROOT"
```

The command prints a canonical JSON summary. A successful run includes:

```json
{"lifecycleState":"succeeded","terminalOutcome":"succeeded"}
```

The real output also includes the Candidate SHA, event digest, state digest, and journal version. Durable evidence is written beneath:

```text
$STATE_ROOT/
└── runs/
    └── fr_fixture_001/
        ├── run-events.ndjson
        └── run-snapshot.json
```

Re-running the same command against the same state root replays and reconciles the existing Factory Run rather than creating an unrelated run.

## CLI

After `npm run build`, invoke the CLI as `node dist/src/cli.js`.

| Command | Purpose |
| --- | --- |
| `run-once --scenario fixture [--state-root <dir>]` | Exercise the complete workflow with deterministic in-memory/fake ports. Defaults to `.factory-state`. |
| `preflight --state-root <dir>` | Validate the pinned GitHub and source-control environment for the live control plane. |
| `bootstrap-source-control --state-root <dir> --issue <n>` | Probe linked-branch support using a real issue and persist the selected source-control capability. |
| `run-once --scenario phase2 --state-root <dir>` | Claim or resume one real GitHub issue and run real GitHub/Git control adapters with deterministic fake later-stage adapters. |

`FACTORY_STATE_ROOT` may be used instead of passing `--state-root`. For live commands, the directory must be outside every repository checkout and have at least 64 MiB available.

### Maintainer-only live control-plane run

> [!CAUTION]
> These commands are not a sandboxed demo. They can relabel and close issues, push branches, open and merge pull requests, and update commit statuses in the configured enterprise repository. The current `phase2` composition uses real GitHub/Git adapters but fake role, rollout, and telemetry adapters.

With the pinned tools installed, the configured GitHub account authenticated, an issue labelled `factory:ready`, and an external state root prepared:

```bash
export FACTORY_STATE_ROOT="$HOME/.local/state/agentic-software-factory"

npm run build
node dist/src/cli.js preflight --state-root "$FACTORY_STATE_ROOT"
node dist/src/cli.js bootstrap-source-control \
  --state-root "$FACTORY_STATE_ROOT" \
  --issue <issue-number>
node dist/src/cli.js run-once \
  --scenario phase2 \
  --state-root "$FACTORY_STATE_ROOT"
```

The orchestrator accepts at most one nonterminal Factory Run. If no eligible `factory:ready` issue exists, it prints `{"status":"no_work"}`.

## Development

```bash
npm run typecheck       # TypeScript checks without emitting files
npm test                # Build and run every test suite
npm run test:acceptance # End-to-end workflow and Tiny Tasks acceptance tests
npm run test:contract   # Canonical JSON and schema contracts
npm run test:control    # GitHub, Git, locking, and recovery behavior
npm run test:domain     # Lifecycle, authorization, and risk policy
npm run test:replay     # Journal and effect replay
npm run test:roles      # Role isolation, schemas, handoffs, and runtime behavior
npm run test:topology   # Process supervision and local release topology
npm run test:routing    # Deterministic routing and request journals
npm run test:telemetry  # Telemetry windows, incidents, and rollout policy
```

### Tiny Tasks acceptance service

Tiny Tasks is the minimal product used to verify release identity, isolated mutable data, health endpoints, and ordinary request behavior.

Run its standalone verification:

```bash
npm run test:tiny-tasks
```

Or start it manually:

```bash
FACTORY_DATA_DIR="$(mktemp -d)" \
FACTORY_INSTANCE_ID="tiny-tasks-local" \
FACTORY_RELEASE_ID="development" \
PORT=0 \
npm run tiny-tasks:start
```

The service writes its selected loopback port and release identity to stdout.

## Repository layout

```text
src/
├── control/       GitHub and Git control-plane adapters
├── domain/        Factory Run, risk, and authorization policy
├── journal/       Durable event journal and replayable snapshots
├── orchestrator/  Stage sequencing and effect reconciliation
├── protocol/      Shared contracts, canonical JSON, and validation
├── roles/         Builder/Verifier/Reviewer process runtime and handoffs
├── runtime/       Release processes, routing, and synthetic traffic
└── telemetry/     Windows, incidents, Observer, and Rollout Babysitter

test/              Contract, domain, replay, control, role, topology,
                   routing, telemetry, and acceptance suites
schemas/v1/        Closed JSON Schemas for persisted and process contracts
examples/tiny-tasks/
                   Minimal identity-aware acceptance application
.scratch/          Local Markdown issue tracker and implementation history
```

## Design principles

- **Local state is authoritative.** GitHub is the request, approval, and status projection surface.
- **Identity is explicit.** Evidence is bound to the Factory Run, full Candidate SHA, process attempts, topology, routing revision, and telemetry window.
- **Every gate fails closed.** Stale, incomplete, conflicting, or ambiguous evidence cannot advance a release.
- **Recovery continues the same run.** Restarts reconcile durable intents and external effects instead of silently duplicating work.
- **Roles advise; the Orchestrator acts.** Only the Orchestrator records lifecycle transitions and performs control-plane mutations.
- **Rollout is deterministic.** Synthetic users, a recorded Rollout Seed, and immutable routing revisions make exposure reproducible.

## Current scope

V1 intentionally supports one configured repository, one active Factory Run, one developer machine, local processes, and synthetic traffic. It does not currently aim to provide multi-repository orchestration, concurrent runs, containers, Kubernetes, cloud deployment, webhook hosting, or production multi-user operation.

Planning decisions and deferred work are recorded in [`.scratch/local-agentic-software-factory-v1`](.scratch/local-agentic-software-factory-v1). Agent-facing repository conventions are documented in [`AGENTS.md`](AGENTS.md) and [`docs/agents`](docs/agents).
