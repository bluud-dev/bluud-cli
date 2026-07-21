/**
 * Golden-fixture regression tests.
 *
 * Unlike the behavioral tests in the other `tests/adapters/*.test.ts` files
 * (which assert on parsed structure — "does the settings JSON contain this
 * hook entry"), these compare the *exact* materialized bytes against files
 * checked into `tests/fixtures/`. That catches drift a structural assertion
 * would miss entirely: a template edit that changes prose/formatting but
 * leaves the asserted fields intact, an accidental line-ending flip, or a
 * change to `mergeJsonFile`'s serialization (indentation, trailing newline).
 *
 * The fixtures were captured from this same rendering code (`renderHookScript`
 * / `claudeCodeAdapter.apply`) with fixed inputs, so a red test here means the
 * *output* changed, not that the fixture was ever hand-authored independently.
 * Regenerate deliberately by re-running the capture and reviewing the diff —
 * never by re-running blind.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderHookScript, hookScriptFileName } from "../../src/lib/adapters/hookScript.js";
import { bundledHooksPath } from "../../src/lib/skills.js";
import { claudeCodeAdapter } from "../../src/lib/adapters/claudecode.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

const FIXTURES = join(__dirname, "..", "fixtures");

async function readFixture(...parts: string[]): Promise<string> {
  return readFile(join(FIXTURES, ...parts), "utf8");
}

describe("golden fixtures: hookScript templates", () => {
  it("renders the POSIX pull-hook script byte-for-byte", async () => {
    const template = await readFile(join(bundledHooksPath(), "bluud-pull-hook.sh"), "utf8");
    const rendered = renderHookScript(template, {
      binary: "/usr/local/bin/bluud",
      format: "",
      posix: true,
    });
    expect(rendered).toBe(await readFixture("hookScript", "posix.sh.golden"));
  });

  it("renders the Windows pull-hook script byte-for-byte (CRLF)", async () => {
    const template = await readFile(join(bundledHooksPath(), "bluud-pull-hook.cmd"), "utf8");
    const rendered = renderHookScript(template, {
      binary: "C:/Users/dev/AppData/Roaming/npm/bluud",
      format: "",
      posix: false,
    });
    const golden = await readFixture("hookScript", "windows.cmd.golden");
    expect(rendered).toBe(golden);
    expect(rendered).toContain("\r\n");
    expect(rendered).not.toMatch(/[^\r]\n/);
  });

  it("renders the POSIX script with the gemini --format substitution byte-for-byte", async () => {
    const template = await readFile(join(bundledHooksPath(), "bluud-pull-hook.sh"), "utf8");
    const rendered = renderHookScript(template, {
      binary: "/usr/local/bin/bluud",
      format: "gemini",
      posix: true,
    });
    expect(rendered).toBe(await readFixture("hookScript", "posix-gemini.sh.golden"));
  });
});

describe("golden fixtures: claude-code adapter output", () => {
  let home: string;
  let cwd: string;

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
    home = await mkdtemp(join(tmpdir(), "bluud-golden-home-"));
    cwd = await mkdtemp(join(tmpdir(), "bluud-golden-cwd-"));
    return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
  }

  it("writes project-scope settings.local.json matching the golden fixture, modulo the volatile script path", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".claude"), { recursive: true });

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const written = await readFile(join(cwd, ".claude", "settings.local.json"), "utf8");
    const golden = await readFixture("claudecode", "settings.local.json.golden");

    // Two things in that path are volatile, and a single fixture cannot encode
    // either: this run's temp cwd, and the hook script's file name, which is
    // .cmd on Windows and .sh everywhere else. Both are normalized to
    // placeholders so the rest of the JSON — schema, hook shape, indentation,
    // trailing newline — still has to match the fixture byte-for-byte.
    const expectedScript = hookScriptFileName(process.platform !== "win32");
    const normalized = written
      .split(cwd.replace(/\\/g, "/"))
      .join("__CWD__")
      .split(expectedScript)
      .join("__HOOK_SCRIPT__");
    expect(normalized).toBe(golden);
    // Normalizing the name out would otherwise stop this test noticing that the
    // wrong platform's script was referenced, so assert it separately.
    expect(written).toContain(expectedScript);
  });

  it("writes the global CLAUDE.md marker block matching the golden fixture", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".claude"), { recursive: true });

    await claudeCodeAdapter.apply(env, { dryRun: false, force: false });

    const claudeMd = await readFile(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toBe(await readFixture("claudecode", "CLAUDE.md.golden"));
  });
});
