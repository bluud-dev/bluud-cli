import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { geminiCliAdapter, uninstallGeminiCli } from "../../src/lib/adapters/geminicli.js";
import { hookScriptCommand, hookScriptFileName } from "../../src/lib/adapters/hookScript.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

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
  home = await mkdtemp(join(tmpdir(), "bluud-gemini-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-gemini-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

describe("geminiCliAdapter", () => {
  it("detect() is false when .gemini does not exist", async () => {
    const env = await makeEnv();
    expect(await geminiCliAdapter.detect(env)).toBe(false);
  });

  it("writes a flat SessionStart entry (no matcher/hooks wrapper) invoking --format=gemini", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".gemini"), { recursive: true });

    const result = await geminiCliAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const settingsPath = join(cwd, ".gemini", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toEqual([
      {
        type: "command",
        command: hookScriptCommand(scriptPath(join(cwd, ".gemini"))),
        name: "bluud-memory-pull",
        timeout: 15000,
      },
    ]);
  });

  it("materializes a script that requests the gemini JSON envelope", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".gemini"), { recursive: true });

    await geminiCliAdapter.apply(env, { dryRun: false, force: false });

    const content = await readFile(scriptPath(join(cwd, ".gemini")), "utf8");
    // POSIX renders `BLUUD_FORMAT='gemini'`, cmd renders `set "BLUUD_FORMAT=gemini"`.
    expect(content).toMatch(/BLUUD_FORMAT='?gemini/);
  });

  it("preserves unrelated existing settings keys", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".gemini"), { recursive: true });
    const settingsPath = join(cwd, ".gemini", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }), "utf8");

    await geminiCliAdapter.apply(env, { dryRun: false, force: false });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("is idempotent: re-applying does not duplicate the entry", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".gemini"), { recursive: true });

    await geminiCliAdapter.apply(env, { dryRun: false, force: false });
    await geminiCliAdapter.apply(env, { dryRun: false, force: false });

    const settings = JSON.parse(await readFile(join(cwd, ".gemini", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".gemini"), { recursive: true });

    await geminiCliAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(join(cwd, ".gemini", "settings.json"))).toBe(false);
  });

  it("uninstallGeminiCli removes only the Bluud entry", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".gemini"), { recursive: true });
    const settingsPath = join(cwd, ".gemini", "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ type: "command", command: "some-other-tool" }] },
      }),
      "utf8",
    );

    await geminiCliAdapter.apply(env, { dryRun: false, force: false });
    const removed = await uninstallGeminiCli(env);
    expect(removed).toBe(true);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart).toEqual([{ type: "command", command: "some-other-tool" }]);
    expect(existsSync(scriptPath(join(cwd, ".gemini")))).toBe(false);
  });
});
