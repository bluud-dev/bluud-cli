import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import os from "node:os";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("../src/lib/skills.js", () => ({
  commandExists: vi.fn(async () => false),
}));

import { existsSync } from "node:fs";
import { commandExists } from "../src/lib/skills.js";
import { detectAgent, detectAgents } from "../src/lib/detect.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedCommandExists = vi.mocked(commandExists);

describe("detect", () => {
  const home = os.homedir();
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedCommandExists.mockResolvedValue(false);
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it("detects claude-code via ~/.claude", async () => {
    mockedExistsSync.mockImplementation((p) => p === join(home, ".claude"));
    expect(await detectAgent("claude-code")).toBe(true);
  });

  it("respects CLAUDE_CONFIG_DIR override for claude-code", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
    mockedExistsSync.mockImplementation((p) => p === "/custom/claude");
    expect(await detectAgent("claude-code")).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith("/custom/claude");
  });

  it("respects CODEX_HOME override and the /etc/codex fallback for codex", async () => {
    process.env.CODEX_HOME = "/custom/codex";
    mockedExistsSync.mockImplementation((p) => p === "/etc/codex");
    expect(await detectAgent("codex")).toBe(true);
  });

  it("returns false when no probe directory exists", async () => {
    expect(await detectAgent("gemini-cli")).toBe(false);
    expect(await detectAgent("cursor")).toBe(false);
  });

  it("detects aider via PATH lookup rather than a directory", async () => {
    mockedCommandExists.mockResolvedValue(true);
    expect(await detectAgent("aider")).toBe(true);
    expect(mockedCommandExists).toHaveBeenCalledWith("aider");
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it("resolves false for an unknown agent name without throwing", async () => {
    expect(await detectAgent("not-a-real-tool")).toBe(false);
  });

  it("detectAgents probes every agent and returns a name -> boolean map", async () => {
    mockedExistsSync.mockImplementation((p) => p === join(home, ".cursor"));
    const result = await detectAgents(["claude-code", "cursor", "windsurf"]);
    expect(result).toEqual({
      "claude-code": false,
      cursor: true,
      windsurf: false,
    });
  });

  // The bulk of the ~73-tool registry expansion is exactly this same
  // directory-probe shape, wired through `agentRegistry.ts` instead of
  // `detect.ts`'s own former DIRECTORY_PROBES map. A couple of examples from
  // that expanded set, distinct from the original 10, prove the wiring
  // actually reaches them rather than only the tools `detect.ts` always knew
  // about.
  it("detects opencode via its XDG config-home directory", async () => {
    mockedExistsSync.mockImplementation((p) => p === join(os.homedir(), ".config", "opencode"));
    expect(await detectAgent("opencode")).toBe(true);
  });

  it("distinguishes antigravity-cli from antigravity (separate probe directories)", async () => {
    mockedExistsSync.mockImplementation((p) => p === join(home, ".gemini", "antigravity-cli"));
    expect(await detectAgent("antigravity-cli")).toBe(true);
    expect(await detectAgent("antigravity")).toBe(false);
  });
});
