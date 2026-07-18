import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { antigravityAdapter, uninstallAntigravity } from "../../src/lib/adapters/antigravity.js";
import { geminiCliAdapter } from "../../src/lib/adapters/geminicli.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-antigravity-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-antigravity-cwd-"));
  return { cwd, home, global: true, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

describe("antigravityAdapter", () => {
  it("detect() is false in project scope (no documented project-scoped hook surface)", async () => {
    const env = await makeEnv({ global: false });
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });
    expect(await antigravityAdapter.detect(env)).toBe(false);
  });

  it("detect() is false when ~/.gemini/antigravity does not exist", async () => {
    const env = await makeEnv({ global: true });
    expect(await antigravityAdapter.detect(env)).toBe(false);
  });

  it("writes the SessionStart hook into the shared ~/.gemini/settings.json", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });

    const result = await antigravityAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const settingsPath = join(home, ".gemini", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toEqual([
      {
        type: "command",
        command: "/usr/local/bin/bluud pull --inject --format=gemini",
        name: "bluud-memory-pull",
        timeout: 15000,
      },
    ]);
  });

  it("never double-registers when Gemini CLI's own adapter already wrote the hook", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });
    await mkdir(join(home, ".gemini"), { recursive: true });

    // Gemini CLI adapter applies first (writes ~/.gemini/settings.json).
    await geminiCliAdapter.apply(env, { dryRun: false, force: false });
    // Antigravity applies second, against the identical shared file.
    await antigravityAdapter.apply(env, { dryRun: false, force: false });

    const settingsPath = join(home, ".gemini", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("preserves unrelated existing settings keys", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });
    const settingsPath = join(home, ".gemini", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }), "utf8");

    await antigravityAdapter.apply(env, { dryRun: false, force: false });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });

    await antigravityAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(false);
  });

  it("uninstallAntigravity removes only the Bluud entry", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".gemini", "antigravity"), { recursive: true });
    await antigravityAdapter.apply(env, { dryRun: false, force: false });

    const removed = await uninstallAntigravity(env);
    expect(removed).toBe(true);
    const settings = JSON.parse(await readFile(join(home, ".gemini", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toEqual([]);
  });
});
