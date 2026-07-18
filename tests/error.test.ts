import { describe, it, expect } from "vitest";
import { statusToErrorCode, guidanceForCode, CliError } from "../src/lib/error.js";

describe("statusToErrorCode", () => {
  it("maps known statuses", () => {
    expect(statusToErrorCode(401)).toBe("auth_required");
    expect(statusToErrorCode(402)).toBe("subscription_required");
    expect(statusToErrorCode(403)).toBe("subscription_required");
    expect(statusToErrorCode(404)).toBe("project_not_found");
    expect(statusToErrorCode(423)).toBe("project_locked");
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
