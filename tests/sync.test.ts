import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncCommand } from "../src/commands/sync.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { ProjectIdentity } from "../src/types.js";

vi.mock("../src/lib/identity.js", () => ({
  requireIdentity: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  saveProjectToken: vi.fn(),
}));

import { requireIdentity } from "../src/lib/identity.js";
import { saveProjectToken } from "../src/lib/config.js";

const mockedRequireIdentity = vi.mocked(requireIdentity);
const mockedSaveProjectToken = vi.mocked(saveProjectToken);

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
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }),
    out: { write: vi.fn(), writeLine: vi.fn(), error: vi.fn(), errorLine: vi.fn() },
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

const identity: ProjectIdentity = {
  projectId: "a3f7c2deadbeef",
  identitySource: "git_remote",
  gitRemote: "github.com/owner/repo",
  path: "/tmp/project",
};

describe("syncCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRequireIdentity.mockResolvedValue(identity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws auth_required when not signed in", async () => {
    const ctx = makeContext();
    await expect(syncCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("fetches and stores the current active token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/projects/${identity.projectId}/token/sync`)) {
        return json({ token: "bluud_pt_synced0000000000000000" });
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    const code = await syncCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedSaveProjectToken).toHaveBeenCalledWith(
      identity.projectId,
      "bluud_pt_synced0000000000000000",
    );
    expect(ctx.out.writeLine).toHaveBeenCalledWith("Project token synced.");
  });

  it("surfaces not_member as a membership error, not a billing one", async () => {
    // require_project_member 403 is a plain string with no {code}.
    const fetchImpl = vi.fn(async () => json({ detail: "Not a project member" }, 403));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(syncCommand.run(ctx)).rejects.toMatchObject({
      code: "api_error",
      message: "Not a project member",
    });
    expect(mockedSaveProjectToken).not.toHaveBeenCalled();
  });

  it("surfaces 404 when no active token exists", async () => {
    const fetchImpl = vi.fn(async () => json({ detail: "No active token" }, 404));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(syncCommand.run(ctx)).rejects.toMatchObject({ code: "project_not_found" });
  });
});
