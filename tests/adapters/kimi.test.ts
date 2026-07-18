import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kimiAdapter, uninstallKimi } from "../../src/lib/adapters/kimi.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-kimi-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-kimi-cwd-"));
  return { cwd, home, global: true, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

describe("kimiAdapter", () => {
  it("detect() is false in project scope regardless of ~/.kimi-code (hooks are user-level only)", async () => {
    const env = await makeEnv({ global: false });
    await mkdir(join(home, ".kimi-code"), { recursive: true });
    expect(await kimiAdapter.detect(env)).toBe(false);
  });

  it("detect() is false when ~/.kimi-code does not exist even in global scope", async () => {
    const env = await makeEnv({ global: true });
    expect(await kimiAdapter.detect(env)).toBe(false);
  });

  it("writes a flat [[hooks]] entry with event=UserPromptSubmit invoking --inject (SessionStart cannot inject there)", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".kimi-code"), { recursive: true });

    const result = await kimiAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const configPath = join(home, ".kimi-code", "config.toml");
    const content = await readFile(configPath, "utf8");
    expect(content).toContain("[[hooks]]");
    expect(content).toContain('event = "UserPromptSubmit"');
    expect(content).toContain("command = '/usr/local/bin/bluud pull --inject'");
    expect(content).not.toContain('event = "SessionStart"');
  });

  it("the plan description documents why UserPromptSubmit is used instead of SessionStart", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".kimi-code"), { recursive: true });

    const plan = await kimiAdapter.plan(env);
    expect(plan.actions[0].description).toContain("UserPromptSubmit");
    expect(plan.actions[0].description).toContain("SessionStart cannot inject context");
  });

  it("is idempotent: re-applying does not duplicate the block", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".kimi-code"), { recursive: true });

    await kimiAdapter.apply(env, { dryRun: false, force: false });
    await kimiAdapter.apply(env, { dryRun: false, force: false });

    const content = await readFile(join(home, ".kimi-code", "config.toml"), "utf8");
    expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(1);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".kimi-code"), { recursive: true });

    await kimiAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(join(home, ".kimi-code", "config.toml"))).toBe(false);
  });

  it("uninstallKimi removes the block", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".kimi-code"), { recursive: true });
    await kimiAdapter.apply(env, { dryRun: false, force: false });

    const removed = await uninstallKimi(env);
    expect(removed).toBe(true);
    const content = await readFile(join(home, ".kimi-code", "config.toml"), "utf8");
    expect(content).not.toContain("hooks");
  });
});
