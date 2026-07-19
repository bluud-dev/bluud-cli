import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reassignCommand } from "../src/commands/reassign.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { ProjectIdentity } from "../src/types.js";

vi.mock("@clack/prompts", async () => ({
  select: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
}));

vi.mock("../src/lib/identity.js", () => ({
  requireIdentity: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  saveProjectToken: vi.fn(),
}));

import * as p from "@clack/prompts";
import { requireIdentity } from "../src/lib/identity.js";
import { saveProjectToken } from "../src/lib/config.js";

const mockedSelect = vi.mocked(p.select);
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
  projectId: "new-local-id",
  identitySource: "git_remote",
  gitRemote: "github.com/owner/repo",
  path: "/tmp/project",
};

const owned = [
  {
    project_id: "proj-a",
    display_name: "Project A",
    identity_source: "git_remote" as const,
    read_only: false,
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-02T00:00:00Z",
  },
  {
    project_id: "proj-b",
    display_name: "Project B",
    identity_source: "git_remote" as const,
    read_only: false,
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-02T00:00:00Z",
  },
];

describe("reassignCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRequireIdentity.mockResolvedValue(identity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws auth_required when not signed in", async () => {
    const ctx = makeContext();
    await expect(reassignCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("throws project_not_found when the user owns nothing", async () => {
    const fetchImpl = vi.fn(async () => json({ projects: [] }));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(reassignCommand.run(ctx)).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("reassigns to the interactively-selected project", async () => {
    mockedSelect.mockResolvedValue("proj-b");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/remap/projects")) return json({ projects: owned });
      if (url.endsWith("/remap/reassign")) {
        expect(JSON.parse(String(init?.body))).toEqual({ target_project_id: "proj-b" });
        return json({ project_id: "proj-b", token: "bluud_pt_reassigned0000000000000" });
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    const code = await reassignCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedSaveProjectToken).toHaveBeenCalledWith(
      "proj-b",
      "bluud_pt_reassigned0000000000000",
    );
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      expect.stringContaining("Reassigned this directory to project proj-b"),
    );
  });

  it("reassigns non-interactively via the positional argument", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/remap/projects")) return json({ projects: owned });
      if (url.endsWith("/remap/reassign")) {
        return json({ project_id: "proj-a", token: "bluud_pt_reassigned0000000000000" });
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api, args: ["proj-a"], nonInteractive: true });
    const code = await reassignCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedSelect).not.toHaveBeenCalled();
    expect(mockedSaveProjectToken).toHaveBeenCalledWith(
      "proj-a",
      "bluud_pt_reassigned0000000000000",
    );
  });

  it("requires a positional target id non-interactively", async () => {
    const fetchImpl = vi.fn(async () => json({ projects: owned }));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api, nonInteractive: true });
    await expect(reassignCommand.run(ctx)).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("rejects a target id the user does not own", async () => {
    const fetchImpl = vi.fn(async () => json({ projects: owned }));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api, args: ["not-owned"], nonInteractive: true });
    await expect(reassignCommand.run(ctx)).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("surfaces not_owner with ownership guidance (explicit backend code)", async () => {
    mockedSelect.mockResolvedValue("proj-b");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/remap/projects")) return json({ projects: owned });
      if (url.endsWith("/remap/reassign")) {
        return json(
          { detail: { code: "not_owner", message: "Reassign requires project ownership" } },
          403,
        );
      }
      return json({}, 404);
    });
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(reassignCommand.run(ctx)).rejects.toMatchObject({
      code: "not_owner",
      message: "Reassign requires project ownership",
    });
  });

  it("propagates cancellation from the interactive selector", async () => {
    mockedSelect.mockResolvedValue(Symbol.for("clack:cancel"));
    const fetchImpl = vi.fn(async () => json({ projects: owned }));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await expect(reassignCommand.run(ctx)).rejects.toMatchObject({ code: "cancelled" });
  });
});
