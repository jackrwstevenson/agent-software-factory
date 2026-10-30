# Local Agentic Software Factory

A deliberately small system that proves an auditable development loop from a GitHub issue through implementation, verification, review, progressive rollout, and observation on one developer machine.

## Workflow

**Factory Run**:
One durably accepted attempt to carry a single GitHub issue through every gated Stage of the software factory. Process recovery continues the same Factory Run; another attempt after a Terminal Outcome is a new Factory Run.
_Avoid_: Job, pipeline run, agent run

**Factory Claim**:
The verified association between one GitHub issue and one Factory Run. A pending claim is not a Factory Run until its local intent and GitHub projection have been reconciled and accepted.
_Avoid_: Assignment, lock

**GitHub Projection**:
The human-visible labels, comments, assignment, pull request, and commit statuses derived from authoritative local Factory Run state.
_Avoid_: Workflow database, source of truth

**Factory Branch**:
The single run-scoped, linear, append-only Git branch that preserves every Candidate Release created by one Factory Run.
_Avoid_: Feature branch, agent branch

**Factory Worktree**:
The isolated checkout of a Factory Branch supplied to roles. It is never the repository's primary checkout.
_Avoid_: Workspace, clone

**Integration Commit**:
The verified default-branch merge commit created after the Observation Window, whose source tree exactly matches the successful Candidate Release.
_Avoid_: Candidate Release, deployment commit

**Release Instance**:
One supervised local process running a Stable Release or Candidate Release in Staging or Simulated Production, with isolated runtime identity, endpoint, logs, and mutable data.
_Avoid_: Deployment, server

**Process Attempt**:
One OS-process generation of a managed Release Instance, Traffic Router, or Synthetic Traffic process. Restart creates a new Process Attempt even when release identity is unchanged.
_Avoid_: Stage Attempt, retry

**Traffic Router**:
The only Simulated Production endpoint, responsible for applying the Orchestrator's recorded exposure decision between Stable and Candidate Release Instances.
_Avoid_: Load balancer, proxy

**Synthetic Traffic**:
The supervised local workload that exercises Simulated Production exclusively through the Traffic Router.
_Avoid_: Test suite, real users

**Synthetic User**:
A stable opaque identity from a versioned local workload manifest, used for sticky routing and exposure accounting without representing a real person.
_Avoid_: Test account, real user

**Rollout Seed**:
The immutable, recorded Factory Run value used with Synthetic User identity to derive deterministic routing cohorts. It is not a secret.
_Avoid_: Random sample, routing percentage

**Routing Revision**:
One immutable applied Traffic Router configuration binding exposure, exact Stable and Candidate releases and Process Attempts, workload identity, and a configuration fingerprint.
_Avoid_: Router state, percentage

**Topology Epoch**:
The run-scoped identity of one exact set of required Process Attempts and verified endpoints. A required process replacement or ownership ambiguity starts a new Topology Epoch.
_Avoid_: Deployment version, Routing Revision

**Telemetry Window**:
An immutable evidence interval bound to one Factory Run, topology, Routing Revision, releases, workload, and telemetry policy.
_Avoid_: Log range, monitoring period

**Evidence Completeness**:
Whether all expected events for a Telemetry Window are ordered, identity-bound, conflict-free, and closed without ambiguity.
_Avoid_: Sample size, healthy

**Evidence Sufficiency**:
Whether complete evidence meets the policy's duration, finished-request, and unique-user floors for evaluation.
_Avoid_: Completeness, success

**Incident**:
A durable record of a deduplicated operational condition for an exact Factory Run and affected release or component scope. It is evidence consumed by the Rollout Babysitter, not a rollout command.
_Avoid_: Error log, rollback decision

**Stage**:
One of the six ordered responsibility boundaries in a Factory Run: Build, Verify, Review, Authorize, Rollout, and Observe. Each Stage produces a recorded decision and supporting evidence before the next Stage may begin.
_Avoid_: Agent, step

**Evidence Bundle**:
The auditable record of a Factory Run, including identities, reports, command outcomes, test results, review decisions, rollout decisions, telemetry snapshots, and linked media.
_Avoid_: Log dump, transcript

**Risk Classification**:
The Reviewer's Candidate-bound decision about residual release risk after review completeness: Low, Elevated, or Prohibited. It is validated against a versioned policy and Orchestrator-derived structural floor.
_Avoid_: Risk score, defect severity

**Low Risk**:
A review-complete Candidate for which every allowlisted correctness, security, operational, reversibility, and scope predicate is affirmatively proven, permitting autonomous Authorization.
_Avoid_: Small change, no findings noticed

**Elevated Risk**:
A review-complete and acceptable Candidate with documented residual risk that requires exact run-and-Candidate-bound human Authorization.
_Avoid_: Failed review, maybe safe

**Prohibited Change**:
A requested or unavoidable Candidate behavior that violates a non-waivable V1 boundary and must be Rejected rather than human-approved.
_Avoid_: Severe bug, high risk

**Repairable Finding**:
A must-fix defect that Builder can remove while preserving the immutable issue's essential intent and V1 boundaries.
_Avoid_: Prohibited Change, residual risk

**Authorization**:
The recorded decision allowing one exact Candidate Release to enter Rollout. Low-risk authorization is autonomous; elevated-risk authorization is supplied by a human. Product changes invalidate authorization.
_Avoid_: Approval status, permission

**Lifecycle State**:
The single authoritative position of an active Factory Run: Building, Verifying, Reviewing, Authorizing, Awaiting Human Authorization, Rolling Out, Observing, Rolling Back, or Paused for Operator. Every nonterminal Lifecycle State belongs to exactly one Stage.
_Avoid_: Status flag, current step

**Paused for Operator**:
A protective Lifecycle State used when reconciliation or infrastructure ambiguity makes automated progression unsafe. It retains the blocked Stage and prior state and never permits a gate to be skipped.
_Avoid_: Failed, awaiting approval

**Stage Attempt**:
One recorded invocation of a role within a Stage, with immutable input identity, result, and evidence. Repair and technical retry create new Stage Attempts without erasing earlier ones.
_Avoid_: Retry, agent run

**Role Invocation**:
One supervised process execution governed by an immutable input manifest, versioned policy, bounded evidence capture, and a schema-constrained advisory result.
_Avoid_: Agent session, conversation

**Handoff Manifest**:
An immutable, Candidate-bound structured artifact created by the Orchestrator from an accepted role result for the minimum needs of a downstream role or gate.
_Avoid_: Prompt transcript, role-to-role message

**Terminal Outcome**:
The immutable result of a finished Factory Run: Succeeded, Rejected, Failed, Rolled Back, or Aborted. Policy- or telemetry-driven restoration of the Stable Release is Rolled Back; a human-directed stop is Aborted even when it requires rollback. A new attempt after any Terminal Outcome is a new Factory Run.
_Avoid_: Final status, completion state

## Roles

**Orchestrator**:
The sole authority for recording Lifecycle State transitions and executing control-plane mutations. Roles and humans provide decisions, observations, or commands for the Orchestrator to validate and record.
_Avoid_: Agent, workflow Stage

**Builder**:
The only role allowed to change product source, responsible for satisfying the GitHub issue and demonstrating the resulting behaviour.
_Avoid_: Agent 1, Codex

**Verifier**:
The read-only role responsible for independently determining whether an exact Candidate Release builds and passes its automated checks.
_Avoid_: Agent 2, CI agent

**Reviewer**:
The read-only role responsible for correctness review, security review, and Risk Classification of an exact Candidate Release without modifying it.
_Avoid_: Agent 3, code-review agent

**Rollout Babysitter**:
The deterministic data-only role responsible for evaluating Staging, progressive exposure, telemetry-based rollout decisions, rollback, and the Observation Window. It proposes runtime decisions for the Orchestrator to execute.
_Avoid_: Agent 4, deploy agent

**Observer**:
The continuously operating logical role responsible for deterministically detecting and reporting operational regressions or incidents from ordered telemetry. It supplies evidence but does not own a Stage or change Lifecycle State.
_Avoid_: Agent 5, observability agent

## Releases and environments

**Candidate Release**:
The immutable product version being evaluated for promotion during a Factory Run. Its source identity includes the full Factory Branch head commit and source-tree SHAs. Builder repair produces a new Candidate Release; evidence for an earlier Candidate Release cannot authorize its replacement.
_Avoid_: New version, canary

**Stable Release**:
The product version currently treated as the safe production baseline. A Candidate Release becomes the Stable Release only when its Factory Run Succeeds after the Observation Window.
_Avoid_: Old version, control

**Staging**:
The environment in which a Candidate Release is exercised without receiving simulated production traffic.
_Avoid_: Test environment

**Simulated Production**:
The local environment where synthetic user traffic is divided between the Stable Release and Candidate Release to exercise production-like rollout decisions.
_Avoid_: Production, local production

**Progressive Rollout**:
The controlled increase of Candidate Release exposure through predefined traffic percentages, with telemetry gates between increases.
_Avoid_: Deployment

**Observation Window**:
The bounded period at 100% Candidate Release exposure during which the Rollout Babysitter continues evaluating the release before the Factory Run can Succeed. The prior Stable Release remains the rollback baseline throughout.
_Avoid_: Bake time, monitoring period
