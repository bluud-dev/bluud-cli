import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rotateCommand } from "../src/commands/rotate.js";
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

describe("rotateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRequireIdentity.mockResolvedValue(identity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws auth_required when not signed in", async () => {
    const ctx = makeContext();
    await expect(rotateCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("rotates and stores the new token for the owner", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/projects/${identity.projectId}/token/rotate`)) {
        return json({ token: "bluud_pt_rotated00000000000000000" });
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    const code = await rotateCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedSaveProjectToken).toHaveBeenCalledWith(
      identity.projectId,
      "bluud_pt_rotated00000000000000000",
    );
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      "Project token rotated. Collaborators must run `bluud sync` to update.",
    );
  });

  it("surfaces not_owner as an ownership error, not a billing one", async () => {
    // require_project_owner 403 is a plain string with no {code} — a
    // contributor calling rotate must see an ownership message, not "needs a
    // paid plan".
    const fetchImpl = vi.fn(async () =>
      json({ detail: "Only the project owner can perform this action" }, 403),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(rotateCommand.run(ctx)).rejects.toMatchObject({
      code: "api_error",
      message: "Only the project owner can perform this action",
    });
    expect(mockedSaveProjectToken).not.toHaveBeenCalled();
  });
});
