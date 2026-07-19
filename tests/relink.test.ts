import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relinkCommand } from "../src/commands/relink.js";
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

describe("relinkCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRequireIdentity.mockResolvedValue(identity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws auth_required when not signed in", async () => {
    const ctx = makeContext();
    await expect(relinkCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("relinks and stores the synced token for an existing member", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/remap/relink")) {
        expect(JSON.parse(String(init?.body))).toEqual({ project_id: identity.projectId });
        return json({ project_id: identity.projectId, token: "bluud_pt_relinked000000000000000" });
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    const code = await relinkCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedSaveProjectToken).toHaveBeenCalledWith(
      identity.projectId,
      "bluud_pt_relinked000000000000000",
    );
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      `Re-linked project ${identity.projectId}. Token synced.`,
    );
  });

  it("surfaces subscription_required with paid-plan guidance (explicit backend code)", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          detail: {
            code: "subscription_required",
            message: "Remap operations require an active paid subscription",
          },
        },
        403,
      ),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(relinkCommand.run(ctx)).rejects.toMatchObject({
      code: "subscription_required",
      message: "Remap operations require an active paid subscription",
    });
  });

  it("surfaces not_member with membership guidance (explicit backend code)", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ detail: { code: "not_member", message: "Not a member of this project" } }, 403),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(relinkCommand.run(ctx)).rejects.toMatchObject({
      code: "not_member",
      message: "Not a member of this project",
    });
  });

  it("surfaces project_not_found (explicit backend code)", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ detail: { code: "project_not_found", message: "Project not found" } }, 404),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(relinkCommand.run(ctx)).rejects.toMatchObject({ code: "project_not_found" });
  });
});
