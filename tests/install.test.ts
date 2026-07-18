import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installCommand } from "../src/commands/install.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { ProjectIdentity, AuthSession } from "../src/types.js";

vi.mock("@clack/prompts", async () => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  password: vi.fn(),
  spinner: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
}));

vi.mock("../src/lib/auth.js", () => ({
  loginWithBrowser: vi.fn(),
  loginWithToken: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
  saveAuth: vi.fn(),
  saveProjectToken: vi.fn(),
}));

vi.mock("../src/lib/identity.js", () => ({
  requireIdentity: vi.fn(),
}));

vi.mock("../src/lib/skills.js", () => ({
  installSkill: vi.fn(),
  bundledSkillPath: vi.fn(() => "/mock/skill"),
}));

vi.mock("../src/lib/adapters/index.js", () => ({
  applyAll: vi.fn(),
}));

import * as p from "@clack/prompts";
import { loginWithBrowser, loginWithToken } from "../src/lib/auth.js";
import { saveAuth, saveProjectToken } from "../src/lib/config.js";
import { requireIdentity } from "../src/lib/identity.js";
import { installSkill } from "../src/lib/skills.js";
import { applyAll } from "../src/lib/adapters/index.js";

const mockedSelect = vi.mocked(p.select);
const mockedMultiselect = vi.mocked(p.multiselect);
const mockedSpinner = vi.mocked(p.spinner);
const mockedLoginWithBrowser = vi.mocked(loginWithBrowser);
const mockedLoginWithToken = vi.mocked(loginWithToken);
const mockedSaveAuth = vi.mocked(saveAuth);
const mockedSaveProjectToken = vi.mocked(saveProjectToken);
const mockedRequireIdentity = vi.mocked(requireIdentity);
const mockedInstallSkill = vi.mocked(installSkill);
const mockedApplyAll = vi.mocked(applyAll);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchImpl(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/account/me")) {
      return json({ id: "u1", email: "dev@bluud.dev" });
    }
    if (url.endsWith("/projects/register")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      return json({
        project_id: "a3f7c2deadbeef",
        display_name: body?.display_name ?? null,
        identity_source: "git_remote",
        token: "bluud_pt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        is_new: true,
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    api: new ApiClient({ baseUrl: "http://localhost:1", fetchImpl: makeFetchImpl() }),
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
    cwd: "/tmp/project-name",
    args: [],
    flags: {},
    nonInteractive: false,
    ...overrides,
  };
}

function makeSpinner() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  } as unknown as ReturnType<typeof p.spinner>;
}

describe("installCommand", () => {
  const identity: ProjectIdentity = {
    projectId: "a3f7c2deadbeef",
    identitySource: "git_remote",
    gitRemote: "github.com/owner/repo",
    path: "/tmp/project-name",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpinner.mockReturnValue(makeSpinner());
    mockedRequireIdentity.mockResolvedValue(identity);
    mockedInstallSkill.mockResolvedValue({ installed: true, mode: "skills" });
    mockedApplyAll.mockResolvedValue([
      {
        name: "claude-code",
        applied: true,
        actions: [
          { path: "settings.json", description: "hook", present: false, wouldChange: true },
        ],
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onboards a new project end-to-end", async () => {
    const session: AuthSession = {
      access_token: "access-xyz",
      refresh_token: "refresh-xyz",
      token_type: "bearer",
    };
    mockedLoginWithBrowser.mockResolvedValue(session);
    mockedMultiselect.mockResolvedValue(["claude-code"]);

    const ctx = makeContext();
    const code = await installCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedSaveAuth).toHaveBeenCalledWith(session, false);
    expect(mockedSaveProjectToken).toHaveBeenCalledWith(
      "a3f7c2deadbeef",
      expect.stringContaining("bluud_pt_"),
    );
    expect(mockedInstallSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "bluud-memory",
        agent: "claude-code",
        global: false,
        cwd: "/tmp/project-name",
      }),
    );
    expect(mockedApplyAll).toHaveBeenCalled();
  });

  it("uses --token for non-interactive auth", async () => {
    const session: AuthSession = {
      access_token: "bluud_pat_xxx",
      refresh_token: "",
      token_type: "bearer",
    };
    mockedLoginWithToken.mockResolvedValue(session);

    const ctx = makeContext({
      flags: { token: "bluud_pat_xxx" },
      nonInteractive: true,
    });
    const code = await installCommand.run(ctx);

    expect(code).toBe(0);
    expect(mockedLoginWithToken).toHaveBeenCalledWith(ctx.api, "bluud_pat_xxx");
    expect(mockedSaveAuth).toHaveBeenCalledWith(session, true);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it("fails non-interactively when not signed in and no --token", async () => {
    const ctx = makeContext({ nonInteractive: true });
    await expect(installCommand.run(ctx)).rejects.toMatchObject({
      code: "auth_required",
    });
  });

  it("limits agents via --agent", async () => {
    const session: AuthSession = {
      access_token: "access",
      refresh_token: "refresh",
      token_type: "bearer",
    };
    mockedLoginWithToken.mockResolvedValue(session);

    const ctx = makeContext({
      flags: { token: "bluud_pat_xxx", agent: ["cursor"] },
      nonInteractive: true,
    });
    await installCommand.run(ctx);

    expect(mockedInstallSkill).toHaveBeenCalledTimes(1);
    expect(mockedInstallSkill).toHaveBeenCalledWith(expect.objectContaining({ agent: "cursor" }));
  });

  it("rejects unknown --agent values", async () => {
    const session: AuthSession = {
      access_token: "access",
      refresh_token: "refresh",
      token_type: "bearer",
    };
    mockedLoginWithToken.mockResolvedValue(session);

    const ctx = makeContext({
      flags: { token: "bluud_pat_xxx", agent: ["unknown-agent"] },
      nonInteractive: true,
    });
    await expect(installCommand.run(ctx)).rejects.toMatchObject({
      code: "config_error",
    });
  });

  it("honors --dry-run for hook adapters", async () => {
    const session: AuthSession = {
      access_token: "access",
      refresh_token: "refresh",
      token_type: "bearer",
    };
    mockedLoginWithToken.mockResolvedValue(session);

    const ctx = makeContext({
      flags: { token: "bluud_pat_xxx", "dry-run": true },
      nonInteractive: true,
    });
    await installCommand.run(ctx);

    expect(mockedApplyAll).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ dryRun: true, force: false }),
    );
  });
});
