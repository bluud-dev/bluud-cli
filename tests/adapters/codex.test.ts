import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexAdapter, uninstallCodex } from "../../src/lib/adapters/codex.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-codex-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-codex-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

describe("codexAdapter", () => {
  it("detect() is false when .codex does not exist", async () => {
    const env = await makeEnv();
    expect(await codexAdapter.detect(env)).toBe(false);
  });

  it("writes the [[hooks.SessionStart]] / [[hooks.SessionStart.hooks]] TOML shape", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".codex"), { recursive: true });

    const result = await codexAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const configPath = join(cwd, ".codex", "config.toml");
    const content = await readFile(configPath, "utf8");
    expect(content).toContain("[[hooks.SessionStart]]");
    expect(content).toContain('matcher = "startup|resume"');
    expect(content).toContain("[[hooks.SessionStart.hooks]]");
    expect(content).toContain('type = "command"');
    expect(content).toContain("command = '/usr/local/bin/bluud pull --inject'");
  });

  it("preserves unrelated existing TOML content (model, other mcp_servers)", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".codex"), { recursive: true });
    const configPath = join(cwd, ".codex", "config.toml");
    await writeFile(
      configPath,
      ['model = "gpt-5-codex"', "", "[mcp_servers.other]", 'command = "other-tool"', ""].join("\n"),
      "utf8",
    );

    await codexAdapter.apply(env, { dryRun: false, force: false });

    const content = await readFile(configPath, "utf8");
    expect(content).toContain('model = "gpt-5-codex"');
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain('command = "other-tool"');
    expect(content).toContain("[[hooks.SessionStart]]");
  });

  it("is idempotent: re-applying does not duplicate the block", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".codex"), { recursive: true });

    await codexAdapter.apply(env, { dryRun: false, force: false });
    await codexAdapter.apply(env, { dryRun: false, force: false });

    const content = await readFile(join(cwd, ".codex", "config.toml"), "utf8");
    expect(content.match(/\[\[hooks\.SessionStart\]\]/g)?.length).toBe(1);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".codex"), { recursive: true });

    await codexAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(join(cwd, ".codex", "config.toml"))).toBe(false);
  });

  it("targets ~/.codex/config.toml in global scope with no trust caveat", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".codex"), { recursive: true });

    const plan = await codexAdapter.plan(env);
    expect(plan.actions[0].description).not.toContain("trust");
    expect(plan.actions[0].path).toBe(join(home, ".codex", "config.toml"));
  });

  it("flags the repo-trust caveat for project scope", async () => {
    const env = await makeEnv({ global: false });
    await mkdir(join(cwd, ".codex"), { recursive: true });

    const plan = await codexAdapter.plan(env);
    expect(plan.actions[0].description).toContain("trust");
  });

  it("uninstallCodex removes the block and preserves everything else", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".codex"), { recursive: true });
    const configPath = join(cwd, ".codex", "config.toml");
    await writeFile(configPath, 'model = "gpt-5-codex"\n', "utf8");

    await codexAdapter.apply(env, { dryRun: false, force: false });
    const removed = await uninstallCodex(env);
    expect(removed).toBe(true);

    const content = await readFile(configPath, "utf8");
    expect(content).toContain('model = "gpt-5-codex"');
    expect(content).not.toContain("hooks.SessionStart");
  });
});
