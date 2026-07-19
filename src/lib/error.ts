/**
 * Structured CLI errors.
 *
 * Every failure path that should surface to the user as a non-zero exit code
 * throws CliError.  Unexpected low-level exceptions are wrapped in CliError
 * at the top-level handler so callers always see a consistent message format.
 */

export type ErrorCode =
  | "auth_required"
  | "auth_failed"
  | "network_error"
  | "api_error"
  | "config_error"
  | "identity_error"
  | "project_not_found"
  | "project_limit_exceeded"
  | "subscription_required"
  | "project_locked"
  | "not_owner"
  | "not_member"
  | "cancelled"
  | "unknown";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;

  constructor(
    message: string,
    {
      code = "unknown",
      exitCode = 1,
      cause,
    }: { code?: ErrorCode; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Map an HTTP status to the CLI's error taxonomy.
 *
 * The backend's typed `{code, message}` detail is preferred by the API client
 * (`isKnownErrorCode` in `api.ts`); this is only the fallback for a response
 * that carries no machine-readable code. `402` still collapses to
 * `subscription_required` for a genuine payment-required response with no
 * code. `403`, however, does **not** default to `subscription_required`:
 * every real paid-gate rejection (`require_dashboard_*`, remap's
 * `_require_paid_subscription`, project registration's tier limit) already
 * sends an explicit `{code: "subscription_required", ...}` object, so a 403
 * that reaches this fallback is always one of the *un-coded* plain-string
 * 403s from `require_project_owner`/`require_project_member`
 * (`backend/app/security/deps.py`) — an ownership or membership rejection
 * that has nothing to do with billing. Guessing `subscription_required` here
 * previously appended a "This needs a paid plan" hint underneath an
 * already-clear "Only the project owner can perform this action" message,
 * which was actively misleading. `api_error` carries no extra guidance, so
 * the backend's own message stands on its own. `423 Locked` is the read-only
 * quota state from concept §9.2.
 */
export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "auth_required";
    case 402:
      return "subscription_required";
    case 404:
      return "project_not_found";
    case 423:
      return "project_locked";
    default:
      return "api_error";
  }
}

/**
 * A one-line, actionable next step for each error class. Appended beneath the
 * raw message by the top-level handler so a failure always tells the user what
 * to do, not just what went wrong. Voice per BLUUD_CONTENT_MINDSET: direct,
 * concrete, no filler.
 */
const ERROR_GUIDANCE: Record<ErrorCode, string | null> = {
  auth_required: "Run `bluud login` to sign in.",
  auth_failed: "Authentication didn't complete. Run `bluud login` and try again.",
  network_error: "Couldn't reach Bluud. Check your connection and try again.",
  api_error: null,
  config_error: "Check permissions on ~/.bluud, then try again.",
  identity_error: "Run this inside your project directory (a git repo or any folder).",
  project_not_found: "Run `bluud` in this directory to register the project first.",
  project_limit_exceeded:
    "Free tier allows 5 projects. Remove one or upgrade at https://bluud.dev/settings/billing.",
  subscription_required: "This needs a paid plan. Manage it at https://bluud.dev/settings/billing.",
  project_locked:
    "This project is read-only (storage full). Free up space or upgrade to write again.",
  not_owner: "Only the project owner can do this. Ask them to run it, or use `bluud reassign`.",
  not_member: "You're not a member of this project. Ask the owner to invite you.",
  cancelled: null,
  unknown: null,
};

/** Return the actionable hint for an error code, or null when none applies. */
export function guidanceForCode(code: ErrorCode): string | null {
  return ERROR_GUIDANCE[code];
}
