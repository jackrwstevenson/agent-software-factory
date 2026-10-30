export type GitHubControlErrorCode =
  | "github_blocked_configuration"
  | "github_blocked_authentication"
  | "github_blocked_capability"
  | "github_backoff"
  | "github_conflict";

export class GitHubControlError extends Error {
  readonly code: GitHubControlErrorCode;

  constructor(code: GitHubControlErrorCode, message: string) {
    super(message);
    this.name = "GitHubControlError";
    this.code = code;
  }
}
