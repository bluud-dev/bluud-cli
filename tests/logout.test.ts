import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logoutCommand } from "../src/commands/logout.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { StoredAuth } from "../src/lib/config.js";

vi.mock("../src/lib/config.js", () => ({
  loadAuth: vi.fn(),
  clearAuth: vi.fn(),
}));

import { loadAuth, clearAuth } from "../src/lib/config.js";

const mockedLoadAuth = vi.mocked(loadAuth);
const mockedClearAuth = vi.mocked(clearAuth);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    api: new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn(async () => json({}, 204)) as unknown as typeof fetch,
    }),
    out: {
      write: vi.fn(),
      writeLine: vi.fn(),
      error: vi.fn(),
      errorLine: vi.fn(),
    },
    log: {
      level: "info",
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      isDebug: () => false,
    },
    cwd: "/tmp/project",
    args: [],
    flags: {},
    nonInteractive: false,
    ...overrides,
  };
}

describe("logoutCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revokes the refresh token and clears local auth", async () => {
    const auth: StoredAuth = {
      access_token: "access-xyz",
      refresh_token: "refresh-xyz",
      token_type: "bearer",
      isPat: false,
    };
    mockedLoadAuth.mockResolvedValue(auth);

    const ctx = makeContext();
    const code = await logoutCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedClearAuth).toHaveBeenCalled();
    expect(ctx.out.writeLine).toHaveBeenCalledWith("Signed out.");
  });

  it("clears local auth for a PAT without calling logout", async () => {
    const auth: StoredAuth = {
      access_token: "bluud_pat_xxx",
      refresh_token: "",
      token_type: "bearer",
      isPat: true,
    };
    mockedLoadAuth.mockResolvedValue(auth);

    const ctx = makeContext();
    const code = await logoutCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedClearAuth).toHaveBeenCalled();
  });

  it("still clears local auth when no session is stored", async () => {
    mockedLoadAuth.mockResolvedValue(null);

    const ctx = makeContext();
    const code = await logoutCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedClearAuth).toHaveBeenCalled();
  });

  it("warns and still clears local auth when server logout fails", async () => {
    const auth: StoredAuth = {
      access_token: "access-xyz",
      refresh_token: "refresh-xyz",
      token_type: "bearer",
      isPat: false,
    };
    mockedLoadAuth.mockResolvedValue(auth);

    const fetchImpl = vi.fn(async () =>
      json({ detail: "Invalid token" }, 401),
    ) as unknown as typeof fetch;
    const ctx = makeContext({
      api: new ApiClient({ baseUrl: "http://localhost:1", fetchImpl }),
    });

    const code = await logoutCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedClearAuth).toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not revoke the session server-side"),
    );
  });
});
