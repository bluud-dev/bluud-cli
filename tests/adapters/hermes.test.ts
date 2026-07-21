import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { hermesAdapter, uninstallHermes } from "../../src/lib/adapters/hermes.js";
import { renderHermesHookNoop, renderHermesHookOutput } from "../../src/lib/memory.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;
let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  setPlatform("linux");
});

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-hermes-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-hermes-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

/** Mark Hermes as installed. */
async function installHermes(): Promise<void> {
  await mkdir(join(home, ".hermes"), { recursive: true });
}

function configPath(): string {
  return join(home, ".hermes", "config.yaml");
}

interface HermesHookEntry {
  command: string;
  timeout: number;
  matcher?: string;
}

interface HermesConfig {
  hooks?: Record<string, HermesHookEntry[]>;
  mcp_servers?: Record<string, { command: string }>;
  model?: string;
}

async function readConfig(): Promise<HermesConfig> {
  return parseYaml(await readFile(configPath(), "utf8")) as HermesConfig;
}

describe("hermesAdapter", () => {
  it("detect() is false when ~/.hermes does not exist", async () => {
    const env = await makeEnv();
    expect(await hermesAdapter.detect(env)).toBe(false);
  });

  it("detect() is true when ~/.hermes exists", async () => {
    const env = await makeEnv();
    await installHermes();
    expect(await hermesAdapter.detect(env)).toBe(true);
  });

  it("writes a pre_llm_call hook — not on_session_start, which cannot inject", async () => {
    const env = await makeEnv();
    await installHermes();

    const result = await hermesAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const config = await readConfig();
    expect(Object.keys(config.hooks)).toEqual(["pre_llm_call"]);
    expect(config.hooks.pre_llm_call).toHaveLength(1);
  });

  it("registers the timeout in SECONDS, within Hermes' 300s ceiling", async () => {
    const env = await makeEnv();
    await installHermes();
    await hermesAdapter.apply(env, { dryRun: false, force: false });

    const entry = (await readConfig()).hooks.pre_llm_call[0];
    expect(entry.timeout).toBe(30);
    expect(entry.timeout).toBeLessThanOrEqual(300);
  });

  it("omits `matcher` — pre_llm_call is not a tool event and has no tool name to match", async () => {
    const env = await makeEnv();
    await installHermes();
    await hermesAdapter.apply(env, { dryRun: false, force: false });

    const entry = (await readConfig()).hooks.pre_llm_call[0];
    expect(entry).not.toHaveProperty("matcher");
  });

  it("points the hook at a materialized script requesting --format=hermes", async () => {
    const env = await makeEnv();
    await installHermes();
    await hermesAdapter.apply(env, { dryRun: false, force: false });

    const scriptPath = join(home, ".hermes", "bluud", "bluud-pull-hook.sh");
    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain("BLUUD_FORMAT='hermes'");
    expect(script).toContain("BLUUD_BINARY='/usr/local/bin/bluud'");

    const entry = (await readConfig()).hooks.pre_llm_call[0];
    expect(entry.command).toContain("bluud-pull-hook.sh");
  });

  it("writes the global config even in project scope — Hermes reads hooks only from ~/.hermes", async () => {
    const env = await makeEnv({ global: false });
    await installHermes();
    await hermesAdapter.apply(env, { dryRun: false, force: false });

    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(join(cwd, ".hermes"))).toBe(false);
  });

  it("preserves comments and unrelated keys in an existing config", async () => {
    const env = await makeEnv();
    await installHermes();
    await writeFile(
      configPath(),
      [
        "# My Hermes config",
        "model: hermes-4-70b",
        "",
        "mcp_servers:",
        "  # keep this comment",
        "  some_server:",
        "    command: /usr/bin/thing",
        "",
      ].join("\n"),
      "utf8",
    );

    await hermesAdapter.apply(env, { dryRun: false, force: false });

    const text = await readFile(configPath(), "utf8");
    expect(text).toContain("# My Hermes config");
    expect(text).toContain("# keep this comment");
    expect(text).toContain("model: hermes-4-70b");

    const config = await readConfig();
    expect(config.mcp_servers.some_server.command).toBe("/usr/bin/thing");
    expect(config.hooks.pre_llm_call).toHaveLength(1);
  });

  it("leaves a user's own pre_llm_call entries alongside Bluud's", async () => {
    const env = await makeEnv();
    await installHermes();
    await writeFile(
      configPath(),
      [
        "hooks:",
        "  pre_llm_call:",
        '    - command: "/usr/bin/my-own-hook"',
        "      timeout: 10",
        "",
      ].join("\n"),
      "utf8",
    );

    await hermesAdapter.apply(env, { dryRun: false, force: false });

    const entries = (await readConfig()).hooks.pre_llm_call;
    expect(entries).toHaveLength(2);
    expect(entries[0].command).toBe("/usr/bin/my-own-hook");
    expect(entries[0].timeout).toBe(10);
  });

  it("is idempotent: re-applying appends no duplicate entry", async () => {
    const env = await makeEnv();
    await installHermes();

    await hermesAdapter.apply(env, { dryRun: false, force: false });
    const first = await readFile(configPath(), "utf8");
    const second = await hermesAdapter.apply(env, { dryRun: false, force: false });

    expect(second.applied).toBe(false);
    expect(await readFile(configPath(), "utf8")).toBe(first);
    expect((await readConfig()).hooks.pre_llm_call).toHaveLength(1);
  });

  it("re-stamps a drifted Bluud entry in place rather than appending", async () => {
    const env = await makeEnv();
    await installHermes();
    // An entry that is ours (its command names a Bluud script) but carries a
    // stale timeout — the shape a version upgrade leaves behind.
    await writeFile(
      configPath(),
      [
        "hooks:",
        "  pre_llm_call:",
        `    - command: "${join(home, ".hermes", "bluud", "bluud-pull-hook.sh").replace(/\\/g, "/")}"`,
        "      timeout: 5",
        "",
      ].join("\n"),
      "utf8",
    );

    await hermesAdapter.apply(env, { dryRun: false, force: false });

    const entries = (await readConfig()).hooks.pre_llm_call;
    expect(entries).toHaveLength(1);
    expect(entries[0].timeout).toBe(30);
  });

  it("refuses to overwrite a `hooks:` key holding a non-mapping value", async () => {
    const env = await makeEnv();
    await installHermes();
    await writeFile(configPath(), "hooks: disabled\n", "utf8");

    const result = await hermesAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(await readFile(configPath(), "utf8")).toBe("hooks: disabled\n");
  });

  it("leaves an unparseable config untouched", async () => {
    const env = await makeEnv();
    await installHermes();
    const broken = "hooks:\n  - [unbalanced\n";
    await writeFile(configPath(), broken, "utf8");

    await hermesAdapter.apply(env, { dryRun: false, force: false });
    expect(await readFile(configPath(), "utf8")).toBe(broken);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv();
    await installHermes();

    await hermesAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(join(home, ".hermes", "bluud"))).toBe(false);
  });

  it("does nothing when Hermes is not installed", async () => {
    const env = await makeEnv();
    const result = await hermesAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(existsSync(configPath())).toBe(false);
  });

  it("refuses to wire the config when a user-authored script occupies the path", async () => {
    const env = await makeEnv();
    await installHermes();
    const dir = join(home, ".hermes", "bluud");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bluud-pull-hook.sh"), "#!/usr/bin/env sh\necho mine\n", "utf8");

    const result = await hermesAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(existsSync(configPath())).toBe(false);
    expect(await readFile(join(dir, "bluud-pull-hook.sh"), "utf8")).toContain("echo mine");
  });

  it("uninstallHermes removes Bluud's entry and the empty scaffolding", async () => {
    const env = await makeEnv();
    await installHermes();
    await hermesAdapter.apply(env, { dryRun: false, force: false });

    expect(await uninstallHermes(env)).toBe(true);

    const config = await readConfig();
    expect(config).not.toHaveProperty("hooks");
    expect(existsSync(join(home, ".hermes", "bluud", "bluud-pull-hook.sh"))).toBe(false);
  });

  it("uninstallHermes keeps a user's own entry and the enclosing hooks block", async () => {
    const env = await makeEnv();
    await installHermes();
    await hermesAdapter.apply(env, { dryRun: false, force: false });

    // Add a neighbour after Bluud's entry.
    const text = await readFile(configPath(), "utf8");
    await writeFile(
      configPath(),
      `${text}    - command: "/usr/bin/my-own-hook"\n      timeout: 10\n`,
      "utf8",
    );

    expect(await uninstallHermes(env)).toBe(true);

    const entries = (await readConfig()).hooks.pre_llm_call;
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe("/usr/bin/my-own-hook");
  });

  it("uninstallHermes reports false when nothing of Bluud's is present", async () => {
    const env = await makeEnv();
    await installHermes();
    await writeFile(configPath(), "model: hermes-4-70b\n", "utf8");

    expect(await uninstallHermes(env)).toBe(false);
    expect(await readFile(configPath(), "utf8")).toBe("model: hermes-4-70b\n");
  });
});

/**
 * Hermes' `pre_llm_call` contract parses stdout as a single JSON object, so
 * both the injecting and the no-op response must be exactly that.
 */
describe("Hermes hook envelope", () => {
  it("wraps content in Hermes' native `context` key", () => {
    const out = renderHermesHookOutput("# Memory\n- one");
    expect(JSON.parse(out)).toEqual({ context: "# Memory\n- one" });
  });

  it("emits `{}` for a no-op rather than empty stdout", () => {
    expect(renderHermesHookNoop()).toBe("{}");
    expect(JSON.parse(renderHermesHookNoop())).toEqual({});
  });

  it("emits a single JSON object with no stray text", () => {
    const out = renderHermesHookOutput('quotes " and \n newlines');
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}")).toBe(true);
    expect(JSON.parse(out).context).toBe('quotes " and \n newlines');
  });
});
