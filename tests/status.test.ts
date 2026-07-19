import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statusCommand } from "../src/commands/status.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { ProjectIdentity } from "../src/types.js";

vi.mock("../src/lib/identity.js", () => ({
  requireIdentity: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  loadProjectToken: vi.fn(),
}));

import { requireIdentity } from "../src/lib/identity.js";
import { loadProjectToken } from "../src/lib/config.js";

const mockedRequireIdentity = vi.mocked(requireIdentity);
const mockedLoadProjectToken = vi.mocked(loadProjectToken);

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

describe("statusCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRequireIdentity.mockResolvedValue(identity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws auth_required when not signed in", async () => {
    const ctx = makeContext();
    await expect(statusCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("prints identity, project, and memory sections for a signed-in owner", async () => {
    mockedLoadProjectToken.mockResolvedValue("bluud_pt_xxx");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/projects/${identity.projectId}/status`)) {
        return json({
          project_id: identity.projectId,
          display_name: "My Project",
          identity_source: "git_remote",
          read_only: false,
          is_owner: true,
          role: "owner",
          created_at: "2025-01-01T00:00:00Z",
          last_activity_at: "2025-01-02T00:00:00Z",
          total_size_bytes: 2048,
          quota_usage_ratio: 0.2,
          token_active: true,
          token_created_at: "2025-01-01T00:00:00Z",
        });
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    const code = await statusCommand.run(ctx);

    expect(code).toBe(0);
    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("My Project");
    expect(lines).toContain("owner");
    expect(lines).toContain("2.0 KB");
    expect(lines).toContain("present");
    expect(lines).toContain("active: yes");
  });

  it("supports --json output", async () => {
    mockedLoadProjectToken.mockResolvedValue(null);
    const fetchImpl = vi.fn(async () =>
      json({
        project_id: identity.projectId,
        display_name: null,
        identity_source: "git_remote",
        read_only: true,
        is_owner: false,
        role: "contributor",
        created_at: "2025-01-01T00:00:00Z",
        last_activity_at: "2025-01-02T00:00:00Z",
        total_size_bytes: 0,
        quota_usage_ratio: 0,
        token_active: false,
        token_created_at: null,
      }),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api, flags: { json: true } });
    const code = await statusCommand.run(ctx);

    expect(code).toBe(0);
    const parsed = JSON.parse((ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(parsed.token_present).toBe(false);
    expect(parsed.status.role).toBe("contributor");
    expect(parsed.status.read_only).toBe(true);
  });

  it("surfaces project_not_found when the project has never been registered", async () => {
    mockedLoadProjectToken.mockResolvedValue(null);
    const fetchImpl = vi.fn(async () => json({ detail: "Project not found" }, 404));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(statusCommand.run(ctx)).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("surfaces not_member with clear (non-subscription) guidance", async () => {
    mockedLoadProjectToken.mockResolvedValue(null);
    // require_project_member (backend/app/security/deps.py) raises a plain
    // string 403 with no {code} object for a non-member — status.ts must not
    // mislabel this as a billing issue.
    const fetchImpl = vi.fn(async () => json({ detail: "Not a project member" }, 403));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(statusCommand.run(ctx)).rejects.toMatchObject({
      code: "api_error",
      message: "Not a project member",
    });
  });
});
