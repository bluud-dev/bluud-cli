import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  applyHookScript,
  hookScriptCommand,
  hookScriptFileName,
  isManagedByBluud,
  planHookScript,
  removeHookScript,
  renderHookScript,
} from "../../src/lib/adapters/hookScript.js";
import { bundledHooksPath } from "../../src/lib/skills.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

let home = "";
let cwd = "";

afterEach(async () => {
  // The pure-function suites below never build an env, so the temp dirs may
  // legitimately be unset here.
  if (home) await rm(home, { recursive: true, force: true });
  if (cwd) await rm(cwd, { recursive: true, force: true });
  home = "";
  cwd = "";
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-hookscript-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-hookscript-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

async function readTemplate(posix: boolean): Promise<string> {
  return readFile(join(bundledHooksPath(), hookScriptFileName(posix)), "utf8");
}

/**
 * Write a stand-in for the `bluud` executable that mimics the real CLI's
 * stream discipline: the memory tree on stdout only on success, diagnostics on
 * stderr, and a non-zero exit on failure.
 */
async function writeFakeBluud(dir: string, options: { fail: boolean }): Promise<string> {
  const path = join(dir, isWindows ? "fake-bluud.cmd" : "fake-bluud");
  const body = isWindows
    ? options.fail
      ? ["@echo off", "(echo boom)1>&2", "exit /b 1", ""].join("\r\n")
      : ["@echo off", "echo MEMORY-TREE", "exit /b 0", ""].join("\r\n")
    : options.fail
      ? ["#!/usr/bin/env sh", "echo boom >&2", "exit 1", ""].join("\n")
      : ["#!/usr/bin/env sh", "echo MEMORY-TREE", "exit 0", ""].join("\n");

  await writeFile(path, body, "utf8");
  if (!isWindows) await chmod(path, 0o755);
  return path;
}

async function runScript(path: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = isWindows
      ? await execFileAsync("cmd.exe", ["/c", path])
      : await execFileAsync(path, []);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

describe("renderHookScript", () => {
  it("substitutes the binary and format placeholders in the POSIX template", async () => {
    const rendered = renderHookScript(await readTemplate(true), {
      binary: "/usr/local/bin/bluud",
      format: "cline",
      posix: true,
    });

    expect(rendered).toContain("BLUUD_BINARY='/usr/local/bin/bluud'");
    expect(rendered).toContain("BLUUD_FORMAT='cline'");
    expect(rendered).not.toContain("@BLUUD_BINARY@");
    expect(rendered).not.toContain("@BLUUD_FORMAT@");
  });

  it("leaves the format assignment empty when no format is requested", async () => {
    const rendered = renderHookScript(await readTemplate(true), {
      binary: "/usr/local/bin/bluud",
      format: "",
      posix: true,
    });

    expect(rendered).toContain("BLUUD_FORMAT=''");
  });

  it('substitutes the Windows template with a `set "VAR="` empty format', async () => {
    const rendered = renderHookScript(await readTemplate(false), {
      binary: "C:\\Program Files\\bluud\\bluud.cmd",
      format: "",
      posix: false,
    });

    expect(rendered).toContain('set "BLUUD_BINARY=C:\\Program Files\\bluud\\bluud.cmd"');
    expect(rendered).toContain('set "BLUUD_FORMAT="');
  });

  it("refuses a binary path that would break out of the POSIX quoting", async () => {
    const template = await readTemplate(true);
    expect(() =>
      renderHookScript(template, { binary: "/opt/it's/bluud", format: "", posix: true }),
    ).toThrow(/single quote/);
  });

  it("refuses a binary path that would break out of the Windows quoting", async () => {
    const template = await readTemplate(false);
    expect(() =>
      renderHookScript(template, { binary: 'C:\\a"b\\bluud.cmd', format: "", posix: false }),
    ).toThrow(/`"` or `%`/);
    expect(() =>
      renderHookScript(template, { binary: "C:\\%PATH%\\bluud.cmd", format: "", posix: false }),
    ).toThrow(/`"` or `%`/);
  });

  it("refuses a binary path containing a line break", async () => {
    const template = await readTemplate(true);
    expect(() =>
      renderHookScript(template, { binary: "/usr/bin/bl\nuud", format: "", posix: true }),
    ).toThrow(/line break/);
  });
});

describe("isManagedByBluud", () => {
  it("accepts the shell comment form and the cmd REM form", () => {
    expect(isManagedByBluud("#!/usr/bin/env sh\n# bluud:managed\n")).toBe(true);
    expect(isManagedByBluud("@echo off\nREM bluud:managed\n")).toBe(true);
    expect(isManagedByBluud("@echo off\nrem bluud:managed\n")).toBe(true);
  });

  it("rejects a file without the marker", () => {
    expect(isManagedByBluud("#!/usr/bin/env sh\necho hi\n")).toBe(false);
  });

  it("rejects the marker appearing as part of a longer line", () => {
    expect(isManagedByBluud("# bluud:managed-by-someone-else\n")).toBe(false);
    expect(isManagedByBluud("echo bluud:managed\n")).toBe(false);
  });

  it("recognizes the shipped templates as managed", async () => {
    expect(isManagedByBluud(await readTemplate(true))).toBe(true);
    expect(isManagedByBluud(await readTemplate(false))).toBe(true);
  });
});

describe("hookScriptCommand", () => {
  it("quotes the path and normalizes backslashes for Git Bash", () => {
    expect(hookScriptCommand("C:\\Users\\me\\.claude\\bluud\\bluud-pull-hook.cmd")).toBe(
      '"C:/Users/me/.claude/bluud/bluud-pull-hook.cmd"',
    );
    expect(hookScriptCommand("/home/me/.claude/bluud/bluud-pull-hook.sh")).toBe(
      '"/home/me/.claude/bluud/bluud-pull-hook.sh"',
    );
  });
});

describe("applyHookScript / planHookScript / removeHookScript", () => {
  it("materializes the script and reports it in the plan", async () => {
    const env = await makeEnv();
    const spec = { dir: join(cwd, ".claude", "bluud") };

    const before = await planHookScript(env, spec);
    expect(before.present).toBe(false);
    expect(before.foreign).toBe(false);
    expect(before.wouldChange).toBe(true);

    const path = await applyHookScript(env, spec);
    expect(path).toBe(join(spec.dir, hookScriptFileName(!isWindows)));
    expect(existsSync(path as string)).toBe(true);

    const after = await planHookScript(env, spec);
    expect(after.present).toBe(true);
    expect(after.wouldChange).toBe(false);
  });

  it("rewrites the script when the bluud path changes, so a stale path self-heals", async () => {
    const env = await makeEnv();
    const spec = { dir: join(cwd, ".claude", "bluud") };
    const path = (await applyHookScript(env, spec)) as string;
    const first = await readFile(path, "utf8");

    const moved: AdapterEnv = { ...env, bluudBinary: "/opt/homebrew/bin/bluud" };
    expect((await planHookScript(moved, spec)).wouldChange).toBe(true);
    await applyHookScript(moved, spec);

    const second = await readFile(path, "utf8");
    expect(second).not.toBe(first);
    expect(second).toContain("/opt/homebrew/bin/bluud");
  });

  it.runIf(!isWindows)("makes the POSIX script executable", async () => {
    const env = await makeEnv();
    const path = (await applyHookScript(env, { dir: join(cwd, ".claude", "bluud") })) as string;
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("never overwrites a user-authored script", async () => {
    const env = await makeEnv();
    const dir = join(cwd, ".claude", "bluud");
    await mkdir(dir, { recursive: true });
    const path = join(dir, hookScriptFileName(!isWindows));
    await writeFile(path, "my own script\n", "utf8");

    const plan = await planHookScript(env, { dir });
    expect(plan.foreign).toBe(true);
    expect(plan.wouldChange).toBe(false);

    expect(await applyHookScript(env, { dir })).toBeNull();
    expect(await readFile(path, "utf8")).toBe("my own script\n");
  });

  it("removes a managed script and its now-empty bluud directory", async () => {
    const env = await makeEnv();
    const dir = join(cwd, ".claude", "bluud");
    const path = (await applyHookScript(env, { dir })) as string;

    expect(await removeHookScript(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the directory when the user left another file in it", async () => {
    const env = await makeEnv();
    const dir = join(cwd, ".claude", "bluud");
    const path = (await applyHookScript(env, { dir })) as string;
    await writeFile(join(dir, "notes.txt"), "mine\n", "utf8");

    expect(await removeHookScript(path)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("refuses to remove a user-authored script", async () => {
    await makeEnv(); // for the temp `cwd` only — removal takes a bare path
    const dir = join(cwd, ".claude", "bluud");
    await mkdir(dir, { recursive: true });
    const path = join(dir, hookScriptFileName(!isWindows));
    await writeFile(path, "my own script\n", "utf8");

    expect(await removeHookScript(path)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("honors the posix override so Cline's unix-only hook is correct anywhere", async () => {
    const env = await makeEnv();
    const dir = join(cwd, ".clinerules", "hooks");
    const path = (await applyHookScript(env, {
      dir,
      fileName: "TaskStart",
      format: "cline",
      posix: true,
    })) as string;

    expect(path).toBe(join(dir, "TaskStart"));
    const content = await readFile(path, "utf8");
    expect(content.startsWith("#!/usr/bin/env sh")).toBe(true);
    expect(content).toContain("BLUUD_FORMAT='cline'");
  });
});

/**
 * The section 9.1 contract, executed rather than asserted about: a failing pull
 * must leave stdout empty and exit 0, because the tools whose hook contract
 * parses stdout as JSON treat a non-zero exit or a partial payload as a broken
 * hook and surface it to the user mid-session.
 */
describe("hook script execution", () => {
  it("passes the memory tree through on success", async () => {
    const env = await makeEnv();
    const fake = await writeFakeBluud(cwd, { fail: false });
    const path = (await applyHookScript(
      { ...env, bluudBinary: fake },
      { dir: join(cwd, "bluud") },
    )) as string;

    const { stdout, code } = await runScript(path);
    expect(code).toBe(0);
    expect(stdout).toContain("MEMORY-TREE");
  });

  it("fails open: empty stdout, exit 0, diagnostic on stderr", async () => {
    const env = await makeEnv();
    const fake = await writeFakeBluud(cwd, { fail: true });
    const path = (await applyHookScript(
      { ...env, bluudBinary: fake },
      { dir: join(cwd, "bluud") },
    )) as string;

    const { stdout, stderr, code } = await runScript(path);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain("continuing without project memory");
    expect(stderr).toContain("boom");
  });

  it("forwards the --format flag to the bluud invocation", async () => {
    const baseEnv = await makeEnv();
    // Echo the received arguments so the flag wiring is observed, not assumed.
    const path = join(cwd, isWindows ? "argecho.cmd" : "argecho");
    await writeFile(
      path,
      isWindows
        ? ["@echo off", "echo ARGS:%*", "exit /b 0", ""].join("\r\n")
        : ["#!/usr/bin/env sh", 'echo "ARGS:$*"', "exit 0", ""].join("\n"),
      "utf8",
    );
    if (!isWindows) await chmod(path, 0o755);

    const scriptPath = (await applyHookScript(
      { ...baseEnv, bluudBinary: path },
      { dir: join(cwd, "bluud"), format: "gemini" },
    )) as string;

    const { stdout } = await runScript(scriptPath);
    expect(stdout).toContain("pull --inject --format=gemini");
  });
});
