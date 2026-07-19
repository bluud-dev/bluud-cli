import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeCodeAdapter, uninstallClaudeCode } from "../../src/lib/adapters/claudecode.js";
import {
  hookScriptCommand,
  hookScriptFileName,
  isManagedByBluud,
} from "../../src/lib/adapters/hookScript.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

/** The script path the adapter materializes for a given config dir. */
function scriptPath(configDir: string): string {
  return join(configDir, "bluud", hookScriptFileName(process.platform !== "win32"));
}

let home: string;
let cwd: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-claude-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-claude-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

describe("claudeCodeAdapter", () => {
  it("detect() is false when neither .claude dir exists", async () => {
    const env = await makeEnv();
    expect(await claudeCodeAdapter.detect(env)).toBe(false);
    const plan = await claudeCodeAdapter.plan(env);
    expect(plan.detected).toBe(false);
  });

  it("detect() is true for project scope when .claude exists in cwd", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });
    expect(await claudeCodeAdapter.detect(env)).toBe(true);
  });

  it("writes a well-formed SessionStart hook using the real matcher/hooks object schema", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });

    const result = await claudeCodeAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toEqual([
      {
        hooks: [{ type: "command", command: hookScriptCommand(scriptPath(join(cwd, ".claude"))) }],
      },
    ]);
  });

  it("materializes the hook script the settings entry points at", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const path = scriptPath(join(cwd, ".claude"));
    const content = await readFile(path, "utf8");
    expect(isManagedByBluud(content)).toBe(true);
    expect(content).toContain("/usr/local/bin/bluud");
  });

  it("stores a stable script path, so a moved bluud binary never restamps settings", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const settingsPath = join(cwd, ".claude", "settings.local.json");

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });
    const first = JSON.parse(await readFile(settingsPath, "utf8"));

    // A second run from a different npx cache path.
    const moved: AdapterEnv = { ...env, bluudBinary: "/tmp/npx-cache-2/bluud" };
    await claudeCodeAdapter.apply(moved, { dryRun: false, force: false });
    const second = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(second.hooks.SessionStart).toEqual(first.hooks.SessionStart);
    expect(second.hooks.SessionStart).toHaveLength(1);
    // …while the script body picks up the new path.
    const content = await readFile(scriptPath(join(cwd, ".claude")), "utf8");
    expect(content).toContain("/tmp/npx-cache-2/bluud");
  });

  it("is idempotent: re-applying does not duplicate the hook entry", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });
    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const settingsPath = join(cwd, ".claude", "settings.local.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("preserves unrelated existing settings keys when merging", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const settingsPath = join(cwd, ".claude", "settings.local.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }, null, 2),
      "utf8",
    );

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(git:*)"] });
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });

    const result = await claudeCodeAdapter.apply(env, { dryRun: true, force: false });
    expect(result.applied).toBe(false);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("writes to the global settings path and CLAUDE.md marker block in global scope", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".claude"), { recursive: true });

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const claudeMd = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("<!-- bluud:memory:start -->");
    expect(claudeMd).toContain("managed by Bluud");
  });

  it("uninstallClaudeCode removes the hook entry and marker block", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const changed = await uninstallClaudeCode(env);
    expect(changed).toBe(true);

    const settingsPath = join(home, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toEqual([]);

    // Regression: the write side previously used a hardcoded marker string
    // while the remove side derived markers from a different scope, so the
    // CLAUDE.md block was never actually removed even though this test's
    // `changed` assertion above stayed green (masked by the hook removal).
    const claudeMd = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain("bluud:memory:start");
    expect(claudeMd).not.toContain("managed by Bluud");

    // The materialized script is Bluud's too, so it goes with the hook entry.
    const { existsSync } = await import("node:fs");
    expect(existsSync(scriptPath(join(home, ".claude")))).toBe(false);
  });

  it("uninstallClaudeCode is a no-op (false) when nothing was ever installed", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });
    expect(await uninstallClaudeCode(env)).toBe(false);
  });
});
