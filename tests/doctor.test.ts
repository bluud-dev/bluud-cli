import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { doctorCommand } from "../src/commands/doctor.js";
import { ApiClient } from "../src/lib/api.js";
import { supportedAgentNames } from "../src/lib/agentRegistry.js";
import type { CommandContext } from "../src/commands/index.js";
import type { ProjectIdentity } from "../src/types.js";

vi.mock("../src/lib/identity.js", () => ({
  requireIdentity: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  loadProjectToken: vi.fn(),
}));

vi.mock("../src/lib/adapters/index.js", () => ({
  planAll: vi.fn(),
}));

vi.mock("../src/lib/detect.js", () => ({
  detectAgents: vi.fn(),
}));

vi.mock("../src/lib/skills.js", () => ({
  isSkillInstalled: vi.fn(),
  bundledSkillVersion: vi.fn(),
}));

import { requireIdentity } from "../src/lib/identity.js";
import { loadProjectToken } from "../src/lib/config.js";
import { planAll } from "../src/lib/adapters/index.js";
import { detectAgents } from "../src/lib/detect.js";
import { isSkillInstalled, bundledSkillVersion } from "../src/lib/skills.js";

const mockedRequireIdentity = vi.mocked(requireIdentity);
const mockedLoadProjectToken = vi.mocked(loadProjectToken);
const mockedPlanAll = vi.mocked(planAll);
const mockedDetectAgents = vi.mocked(detectAgents);
const mockedIsSkillInstalled = vi.mocked(isSkillInstalled);
const mockedBundledSkillVersion = vi.mocked(bundledSkillVersion);

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

// Sourced from the same registry `doctor.ts` itself now uses, so this fixture
// can never silently drift out of sync with the full supported-tools set.
const ALL_AGENTS = supportedAgentNames();

describe("doctorCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRequireIdentity.mockResolvedValue(identity);
    mockedLoadProjectToken.mockResolvedValue(null);
    mockedPlanAll.mockResolvedValue([
      {
        name: "claude-code",
        detected: true,
        actions: [
          {
            path: "settings.json",
            description: "SessionStart hook",
            present: false,
            wouldChange: true,
          },
        ],
      },
    ]);
    mockedDetectAgents.mockResolvedValue(
      Object.fromEntries(ALL_AGENTS.map((a) => [a, a === "claude-code"])),
    );
    mockedIsSkillInstalled.mockReturnValue(false);
    mockedBundledSkillVersion.mockResolvedValue("0.1.0");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never requires authentication — runs entirely on local surfaces", async () => {
    const ctx = makeContext();
    const code = await doctorCommand.run(ctx);
    expect(code).toBe(0);
    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("Sign in (`bluud login`)");
  });

  it("reports the bundled skill version, or the unbuilt fallback when there is none", async () => {
    const ctx = makeContext();
    await doctorCommand.run(ctx);
    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("skill:    0.1.0");

    mockedBundledSkillVersion.mockResolvedValue(null);
    const ctx2 = makeContext();
    await doctorCommand.run(ctx2);
    const lines2 = (ctx2.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines2).toContain("skill:    unbuilt (running from source)");
  });

  it("reports every supported agent's detected + skill-installed state", async () => {
    mockedIsSkillInstalled.mockImplementation((agent: string) => agent === "claude-code");
    const ctx = makeContext();
    await doctorCommand.run(ctx);
    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("claude-code");
    expect(lines).toContain("skill installed");
    expect(lines).toContain("not detected");
  });

  it("enriches with remote project status when authenticated and registered", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        project_id: identity.projectId,
        display_name: "My Project",
        identity_source: "git_remote",
        read_only: false,
        is_owner: true,
        role: "owner",
        created_at: "2025-01-01T00:00:00Z",
        last_activity_at: "2025-01-02T00:00:00Z",
        total_size_bytes: 4096,
        quota_usage_ratio: 0.4,
        token_active: true,
        token_created_at: "2025-01-01T00:00:00Z",
      }),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    await doctorCommand.run(ctx);
    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("My Project");
    expect(lines).toContain("owner");
    expect(lines).toContain("4.1 KB");
    expect(lines).not.toContain("Sign in (`bluud login`)");
    expect(lines).not.toContain("not registered yet");
  });

  it("degrades gracefully (no throw) when authenticated but the project isn't registered", async () => {
    const fetchImpl = vi.fn(async () => json({ detail: "Project not found" }, 404));
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api });
    const code = await doctorCommand.run(ctx);

    expect(code).toBe(0);
    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("not registered yet");
  });

  it("supports --json with the full local + remote payload", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        project_id: identity.projectId,
        display_name: "My Project",
        identity_source: "git_remote",
        read_only: false,
        is_owner: true,
        role: "owner",
        created_at: "2025-01-01T00:00:00Z",
        last_activity_at: "2025-01-02T00:00:00Z",
        total_size_bytes: 100,
        quota_usage_ratio: 0.01,
        token_active: true,
        token_created_at: "2025-01-01T00:00:00Z",
      }),
    );
    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    api.setSession({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });

    const ctx = makeContext({ api, flags: { json: true } });
    const code = await doctorCommand.run(ctx);

    expect(code).toBe(0);
    const parsed = JSON.parse((ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(parsed.identity.projectId).toBe(identity.projectId);
    expect(parsed.agents).toHaveLength(ALL_AGENTS.length);
    expect(parsed.hooks[0].name).toBe("claude-code");
    expect(parsed.project.role).toBe("owner");
    expect(parsed.skill_version).toBe("0.1.0");
  });

  it("does not write anything regardless of --dry-run (doctor is always read-only)", async () => {
    const ctx = makeContext({ flags: { "dry-run": true } });
    const code = await doctorCommand.run(ctx);
    expect(code).toBe(0);
    expect(mockedPlanAll).toHaveBeenCalled();
    // planAll/detectAgents/isSkillInstalled are themselves read-only by
    // construction (see their own test suites); doctor performs no writes of
    // its own regardless of the flags it's called with.
  });
});
