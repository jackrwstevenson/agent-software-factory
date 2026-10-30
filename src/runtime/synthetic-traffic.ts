import { performance } from "node:perf_hooks";
import type { DeterministicRouter, RoutingDecision } from "./routing.js";
import {
  RuntimeEventJournal,
  startedEvent,
  type ProtocolFaultKind,
  type RequestBinding
} from "./request-journal.js";

export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

export interface DispatchInput {
  readonly requestId: string;
  readonly userId: string;
  readonly attempt: number;
  readonly assignment: RoutingDecision;
}

export interface DispatchResponse {
  readonly releaseId: string;
  readonly processAttempt: number;
  readonly statusCode: number;
}

export interface LogicalRequestInput {
  readonly router: DeterministicRouter;
  readonly journal: RuntimeEventJournal;
  readonly requestId: string;
  readonly userId: string;
  readonly maxAttempts: number;
  readonly expectedProcessAttempt: number;
  readonly binding: RequestBinding;
  readonly dispatch: (input: DispatchInput) => Promise<DispatchResponse>;
}

export interface LogicalRequestResult {
  readonly assignment: RoutingDecision;
  readonly attempts: number;
  readonly outcome: "success" | "failed";
  readonly response: DispatchResponse | null;
}

function at(): string {
  return new Date().toISOString();
}

export async function runLogicalRequest(input: LogicalRequestInput): Promise<LogicalRequestResult> {
  if (input.requestId.length === 0) throw new TypeError("requestId must not be empty");
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new TypeError("maxAttempts must be a positive integer");
  if (input.maxAttempts > 3) throw new TypeError("maxAttempts must be at most 3");
  if (!Number.isInteger(input.expectedProcessAttempt) || input.expectedProcessAttempt < 1) {
    throw new TypeError("expectedProcessAttempt must be a positive integer");
  }
  const assignment = input.router.decide(input.userId);
  input.journal.append(startedEvent({
    requestId: input.requestId,
    userId: input.userId,
    assignment,
    processAttempt: input.expectedProcessAttempt,
    binding: input.binding,
    at: at()
  }));

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    input.journal.append({
      type: "attempt_started",
      factoryRunId: assignment.factoryRunId,
      at: at(),
      ...input.binding,
      requestId: input.requestId,
      target: assignment.target,
      releaseId: assignment.releaseId,
      processAttempt: input.expectedProcessAttempt,
      attempt
    });
    const startedAt = performance.now();
    let response: DispatchResponse | null = null;
    let outcome: "success" | "error" | "unavailable";
    try {
      response = await input.dispatch({
        requestId: input.requestId,
        userId: input.userId,
        attempt,
        assignment
      });
      if (!response || typeof response !== "object") {
        return protocolFault(input, assignment, attempt, startedAt, null, "invalid_response", "dispatch returned no response");
      }
      if (response.releaseId !== assignment.releaseId) {
        return protocolFault(
          input,
          assignment,
          attempt,
          startedAt,
          response,
          "release_identity_mismatch",
          `release identity mismatch for ${input.requestId}: expected ${assignment.releaseId}, got ${response.releaseId}`
        );
      }
      if (response.processAttempt !== input.expectedProcessAttempt) {
        return protocolFault(
          input,
          assignment,
          attempt,
          startedAt,
          response,
          "process_identity_mismatch",
          `process identity mismatch for ${input.requestId}: expected attempt ${input.expectedProcessAttempt}, got ${response.processAttempt}`
        );
      }
      if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
        return protocolFault(input, assignment, attempt, startedAt, response, "invalid_response", `invalid statusCode for ${input.requestId}`);
      }
      outcome = response.statusCode >= 200 && response.statusCode < 400 ? "success" : "error";
    } catch (error) {
      if (!(error instanceof UnavailableError)) throw error;
      outcome = "unavailable";
    }

    const latencyMs = Number((performance.now() - startedAt).toFixed(3));
    input.journal.append({
      type: "attempt_finished",
      factoryRunId: assignment.factoryRunId,
      at: at(),
      ...input.binding,
      requestId: input.requestId,
      target: assignment.target,
      releaseId: assignment.releaseId,
      processAttempt: input.expectedProcessAttempt,
      attempt,
      outcome,
      statusCode: response?.statusCode ?? null,
      latencyMs
    });

    if (outcome === "success") {
      input.journal.append({
        type: "request_finished",
        factoryRunId: assignment.factoryRunId,
        at: at(),
        ...input.binding,
        requestId: input.requestId,
        target: assignment.target,
        releaseId: assignment.releaseId,
        processAttempt: input.expectedProcessAttempt,
        attempts: attempt,
        outcome: "success"
      });
      return { assignment, attempts: attempt, outcome: "success", response };
    }

    if (attempt === input.maxAttempts) {
      input.journal.append({
        type: "request_finished",
        factoryRunId: assignment.factoryRunId,
        at: at(),
        ...input.binding,
        requestId: input.requestId,
        target: assignment.target,
        releaseId: assignment.releaseId,
        processAttempt: input.expectedProcessAttempt,
        attempts: attempt,
        outcome: "failed"
      });
      return { assignment, attempts: attempt, outcome: "failed", response };
    }
  }
  throw new Error(`unreachable retry state for ${input.requestId}`);
}

function protocolFault(
  input: LogicalRequestInput,
  assignment: RoutingDecision,
  attempt: number,
  startedAt: number,
  response: DispatchResponse | null,
  faultKind: ProtocolFaultKind,
  detail: string
): never {
  const common = {
    factoryRunId: assignment.factoryRunId,
    ...input.binding,
    requestId: input.requestId,
    target: assignment.target,
    releaseId: assignment.releaseId,
    processAttempt: input.expectedProcessAttempt
  } as const;
  input.journal.append({
    type: "protocol_fault",
    at: at(),
    ...common,
    attempt,
    faultKind,
    expectedReleaseId: assignment.releaseId,
    observedReleaseId: response?.releaseId ?? null,
    expectedProcessAttempt: input.expectedProcessAttempt,
    observedProcessAttempt: response?.processAttempt ?? null,
    detail
  });
  input.journal.append({
    type: "attempt_finished",
    at: at(),
    ...common,
    attempt,
    outcome: "error",
    statusCode: response?.statusCode ?? null,
    latencyMs: Number((performance.now() - startedAt).toFixed(3))
  });
  input.journal.append({
    type: "request_finished",
    at: at(),
    ...common,
    attempts: attempt,
    outcome: "failed"
  });
  throw new Error(detail);
}
