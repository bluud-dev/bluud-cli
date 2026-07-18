import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loginCommand } from "../src/commands/login.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { AuthSession } from "../src/types.js";

vi.mock("@clack/prompts", async () => {
  return {
    select: vi.fn(),
    password: vi.fn(),
    spinner: vi.fn(),
    isCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  };
});

vi.mock("../src/lib/auth.js", () => ({
  loginWithBrowser: vi.fn(),
  loginWithToken: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  saveAuth: vi.fn(),
}));

import * as p from "@clack/prompts";
import { loginWithBrowser, loginWithToken } from "../src/lib/auth.js";
import { saveAuth } from "../src/lib/config.js";

const mockedSelect = vi.mocked(p.select);
const mockedPassword = vi.mocked(p.password);
const mockedSpinner = vi.mocked(p.spinner);
const mockedLoginWithBrowser = vi.mocked(loginWithBrowser);
const mockedLoginWithToken = vi.mocked(loginWithToken);
const mockedSaveAuth = vi.mocked(saveAuth);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/account/me")) {
      return json({ id: "u1", email: "dev@bluud.dev" });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  return {
    api: new ApiClient({ baseUrl: "http://localhost:1", fetchImpl }),
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

describe("loginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpinner.mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    } as unknown as ReturnType<typeof p.spinner>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs in with --token non-interactively", async () => {
    const session: AuthSession = {
      access_token: "bluud_pat_xxx",
      refresh_token: "",
      token_type: "bearer",
    };
    mockedLoginWithToken.mockResolvedValue(session);

    const ctx = makeContext({ flags: { token: "bluud_pat_xxx" }, nonInteractive: true });
    const code = await loginCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedLoginWithToken).toHaveBeenCalledWith(ctx.api, "bluud_pat_xxx");
    expect(mockedSaveAuth).toHaveBeenCalledWith(session, true);
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      "Authenticated as dev@bluud.dev with personal access token.",
    );
  });

  it("fails in non-interactive mode without --token", async () => {
    const ctx = makeContext({ nonInteractive: true });
    await expect(loginCommand.run(ctx)).rejects.toMatchObject({
      code: "auth_failed",
      message: expect.stringContaining("--token"),
    });
  });

  it("logs in via browser when the user selects it", async () => {
    mockedSelect.mockResolvedValue("browser");
    const session: AuthSession = {
      access_token: "access-xyz",
      refresh_token: "refresh-xyz",
      token_type: "bearer",
    };
    mockedLoginWithBrowser.mockResolvedValue(session);

    const ctx = makeContext();
    const code = await loginCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedLoginWithBrowser).toHaveBeenCalledWith(ctx.api, expect.any(Object));
    expect(mockedSaveAuth).toHaveBeenCalledWith(session, false);
    expect(ctx.out.writeLine).toHaveBeenCalledWith("Authenticated as dev@bluud.dev.");
  });

  it("logs in via pasted token when the user selects it", async () => {
    mockedSelect.mockResolvedValue("token");
    mockedPassword.mockResolvedValue("bluud_pat_pasted");
    const session: AuthSession = {
      access_token: "bluud_pat_pasted",
      refresh_token: "",
      token_type: "bearer",
    };
    mockedLoginWithToken.mockResolvedValue(session);

    const ctx = makeContext();
    const code = await loginCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedLoginWithToken).toHaveBeenCalledWith(ctx.api, "bluud_pat_pasted");
    expect(mockedSaveAuth).toHaveBeenCalledWith(session, true);
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      "Authenticated as dev@bluud.dev with personal access token.",
    );
  });

  it("cancels when the user aborts the method prompt", async () => {
    mockedSelect.mockResolvedValue(Symbol.for("clack:cancel"));

    const ctx = makeContext();
    await expect(loginCommand.run(ctx)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels when the user aborts the password prompt", async () => {
    mockedSelect.mockResolvedValue("token");
    mockedPassword.mockResolvedValue(Symbol.for("clack:cancel"));

    const ctx = makeContext();
    await expect(loginCommand.run(ctx)).rejects.toMatchObject({ code: "cancelled" });
  });
});
