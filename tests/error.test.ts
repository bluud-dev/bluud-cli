import { describe, it, expect } from "vitest";
import { statusToErrorCode, guidanceForCode, CliError } from "../src/lib/error.js";

describe("statusToErrorCode", () => {
  it("maps known statuses", () => {
    expect(statusToErrorCode(401)).toBe("auth_required");
    expect(statusToErrorCode(402)).toBe("subscription_required");
    expect(statusToErrorCode(404)).toBe("project_not_found");
    expect(statusToErrorCode(423)).toBe("project_locked");
  });

  it("does not guess subscription_required for an un-coded 403", () => {
    // require_project_owner/require_project_member (backend/app/security/deps.py)
    // raise a plain-string 403 with no {code, message} object for ownership and
    // membership rejections — those endpoints (rotate, sync, status) carry no
    // subscription gate at all. Defaulting to subscription_required here would
    // append a "This needs a paid plan" hint under an unrelated ownership
    // error. Every real paid-gate rejection sends an explicit code and is
    // picked up by `isKnownErrorCode` in api.ts before this fallback runs.
    expect(statusToErrorCode(403)).toBe("api_error");
  });

  it("falls back to api_error for unmapped statuses", () => {
    expect(statusToErrorCode(500)).toBe("api_error");
    expect(statusToErrorCode(418)).toBe("api_error");
  });
});

describe("guidanceForCode", () => {
  it("provides an actionable hint for gated codes", () => {
    expect(guidanceForCode("auth_required")).toContain("bluud login");
    expect(guidanceForCode("subscription_required")).toContain("plan");
    expect(guidanceForCode("project_locked")).toContain("read-only");
    expect(guidanceForCode("project_limit_exceeded")).toContain("5 projects");
    expect(guidanceForCode("not_owner")).toContain("owner");
    expect(guidanceForCode("not_member")).toContain("invite");
  });

  it("returns null where no hint applies", () => {
    expect(guidanceForCode("cancelled")).toBeNull();
    expect(guidanceForCode("api_error")).toBeNull();
  });
});

describe("CliError", () => {
  it("defaults to unknown/exit 1 and carries code + cause", () => {
    const base = new CliError("x");
    expect(base.code).toBe("unknown");
    expect(base.exitCode).toBe(1);

    const cause = new Error("root");
    const wrapped = new CliError("y", { code: "network_error", cause });
    expect(wrapped.code).toBe("network_error");
    expect(wrapped.cause).toBe(cause);
  });
});
