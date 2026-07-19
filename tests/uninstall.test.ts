import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fakeHome = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});

vi.mock("@clack/prompts", () => ({
  multiselect: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
}));

import * as p from "@clack/prompts";
import { uninstallCommand } from "../src/commands/uninstall.js";
import { claudeCodeAdapter } from "../src/lib/adapters/claudecode.js";
import { codexAdapter } from "../src/lib/adapters/codex.js";
import type { AdapterEnv } from "../src/lib/adapters/types.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";

const mockedMultiselect = vi.mocked(p.multiselect);

let cwd: string;

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
    cwd,
    args: [],
    flags: {},
    nonInteractive: true,
    ...overrides,
  };
}

describe("uninstallCommand", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fakeHome = await mkdtemp(join(tmpdir(), "bluud-uninstall-home-"));
    cwd = await mkdtemp(join(tmpdir(), "bluud-uninstall-cwd-"));
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("removes both the skill files and the hook for an installed tool", async () => {
    // Install a real hook + real skill dir for claude-code in project scope,
    // mirroring what `bluud install` would have written.
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const env: AdapterEnv = {
      cwd,
      home: fakeHome,
      global: false,
      bluudBinary: process.argv[1] ?? "bluud",
    };
    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });
    await mkdir(join(cwd, ".claude", "skills", "bluud-memory"), { recursive: true });

    const ctx = makeContext({ flags: { agent: ["claude-code"] } });
    const code = await uninstallCommand.run(ctx);

    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".claude", "skills", "bluud-memory"))).toBe(false);
    const settings = JSON.parse(
      await readFile(join(cwd, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.hooks.SessionStart).toEqual([]);
  });

  it("--dry-run reports what would be removed without touching disk", async () => {
    await mkdir(join(cwd, ".codex"), { recursive: true });
    const env: AdapterEnv = {
      cwd,
      home: fakeHome,
      global: false,
      bluudBinary: process.argv[1] ?? "bluud",
    };
    await codexAdapter.apply(env, { dryRun: false, force: false });
    await mkdir(join(cwd, ".codex", "skills", "bluud-memory"), { recursive: true });

    const ctx = makeContext({ flags: { agent: ["codex"], "dry-run": true } });
    const code = await uninstallCommand.run(ctx);

    expect(code).toBe(0);
    // Nothing was actually removed.
    expect(existsSync(join(cwd, ".codex", "skills", "bluud-memory"))).toBe(true);
    const configToml = await readFile(join(cwd, ".codex", "config.toml"), "utf8");
    expect(configToml).toContain("bluud:session-start:start");
    expect(configToml).toContain("[[hooks.SessionStart]]");

    const lines = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(lines).toContain("codex: skill, hook");
  });

  it("--json reports per-agent skill/hook state without writing when combined with --dry-run", async () => {
    const ctx = makeContext({ flags: { agent: ["cursor"], json: true, "dry-run": true } });
    const code = await uninstallCommand.run(ctx);

    expect(code).toBe(0);
    const parsed = JSON.parse((ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.agents).toEqual([
      {
        agent: "cursor",
        skillWasInstalled: false,
        skillRemoved: false,
        hookWasConfigured: false,
        hookRemoved: false,
      },
    ]);
  });

  it("is a no-op for a tool that was never installed", async () => {
    const ctx = makeContext({ flags: { agent: ["windsurf"] } });
    const code = await uninstallCommand.run(ctx);
    expect(code).toBe(0);
    expect(ctx.out.writeLine).toHaveBeenCalledWith("Uninstalled Bluud from: windsurf");
  });

  it("rejects unknown --agent values", async () => {
    const ctx = makeContext({ flags: { agent: ["not-a-real-tool"] } });
    await expect(uninstallCommand.run(ctx)).rejects.toMatchObject({ code: "config_error" });
  });

  it("defaults to every supported agent non-interactively, honoring --agents-skip", async () => {
    const ctx = makeContext({
      flags: { "agents-skip": ["cursor", "windsurf", "aider", "github-copilot"] },
    });
    const code = await uninstallCommand.run(ctx);
    expect(code).toBe(0);
    const message = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(message).toContain("claude-code");
    expect(message).not.toContain("cursor");
  });

  it("prompts interactively and reports nothing selected", async () => {
    mockedMultiselect.mockResolvedValue([]);
    const ctx = makeContext({ nonInteractive: false });
    const code = await uninstallCommand.run(ctx);
    expect(code).toBe(0);
    expect(ctx.out.writeLine).toHaveBeenCalledWith("No tools selected. Nothing to uninstall.");
  });

  it("propagates cancellation from the interactive multiselect", async () => {
    mockedMultiselect.mockResolvedValue(Symbol.for("clack:cancel"));
    const ctx = makeContext({ nonInteractive: false });
    await expect(uninstallCommand.run(ctx)).rejects.toMatchObject({ code: "cancelled" });
  });
});
