import type { RoleTechnicalOutcome } from "./contracts.js";

export class RoleRuntimeError extends Error {
  readonly code: RoleTechnicalOutcome;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RoleTechnicalOutcome, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "RoleRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export class AcceptedRoleDecisionError extends Error {
  readonly decision: string;
  readonly acceptedResultPath: string;

  constructor(decision: string, acceptedResultPath: string) {
    super(`accepted role decision requires orchestration handling: ${decision}`);
    this.name = "AcceptedRoleDecisionError";
    this.decision = decision;
    this.acceptedResultPath = acceptedResultPath;
  }
}
