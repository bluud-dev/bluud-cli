/**
 * Cross-platform hardening coverage (Phase 15).
 *
 * The three platform-specific code paths — Windows junctions, POSIX relative
 * symlinks, and the shell quoting a hook command must survive — cannot all be
 * exercised on one host, so `process.platform` is stubbed to drive each branch
 * deliberately. Where a test asserts real filesystem behaviour it uses the
 * host's actual platform instead, and is skipped elsewhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink), rename: vi.fn(actual.rename) };
});

import { symlink as symlinkMock, rename as renameMock } from "node:fs/promises";
import { linkOrCopy, canonicalSkillsDir, readSymlink } from "../src/lib/skills.js";
import { hookScriptCommand, hookScriptCommandOrNull } from "../src/lib/adapters/hookScript.js";
import { atomicWriteFile } from "../src/lib/adapters/writer.js";

const isWindows = process.platform === "win32";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "bluud-xplat-"));
  vi.mocked(symlinkMock).mockClear();
  vi.mocked(renameMock).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(workDir, { recursive: true, force: true });
});

/** Replace `process.platform` for the duration of one test. */
function stubPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

async function makeSkillDir(name: string): Promise<string> {
  const dir = join(workDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "canonical body", "utf8");
  return dir;
}

describe("linkOrCopy — platform link strategy", () => {
  it("uses a junction with an absolute target on Windows", async () => {
    // A junction stores a fully-qualified path; a relative target would be
    // resolved against the process cwd, silently producing a dead link.
    stubPlatform("win32");
    const target = await makeSkillDir("canonical-win");
    const linkPath = join(workDir, "agent-win");

    await linkOrCopy(target, linkPath);

    const call = vi.mocked(symlinkMock).mock.calls[0];
    expect(call?.[2]).toBe("junction");
    expect(isAbsolute(call?.[0] as string)).toBe(true);
  });

  it("uses a relative 'dir' symlink on POSIX so the tree survives being moved", async () => {
    stubPlatform("linux");
    const target = await makeSkillDir("canonical-posix");
    const linkPath = join(workDir, "agent-posix");

    await linkOrCopy(target, linkPath);

    const call = vi.mocked(symlinkMock).mock.calls[0];
    expect(call?.[2]).toBe("dir");
    expect(isAbsolute(call?.[0] as string)).toBe(false);
  });

  it("uses the same relative-symlink strategy on macOS as on Linux", async () => {
    stubPlatform("darwin");
    const target = await makeSkillDir("canonical-darwin");
    const linkPath = join(workDir, "agent-darwin");

    await linkOrCopy(target, linkPath);

    const call = vi.mocked(symlinkMock).mock.calls[0];
    expect(call?.[2]).toBe("dir");
    expect(isAbsolute(call?.[0] as string)).toBe(false);
  });
});

describe("linkOrCopy — copy fallback", () => {
  it("falls back to a recursive copy when linking is refused (EPERM)", async () => {
    // Windows without Developer Mode or admin rights, and restrictive network
    // shares, both surface as a rejected symlink call.
    vi.mocked(symlinkMock).mockRejectedValueOnce(
      Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" }),
    );
    const target = await makeSkillDir("canonical-eperm");
    const linkPath = join(workDir, "agent-eperm");

    const mode = await linkOrCopy(target, linkPath);

    expect(mode).toBe("copy");
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("canonical body");
    // A copy is a real directory, not a link.
    expect(await readSymlink(linkPath)).toBeNull();
  });

  it("reports 'symlink' when linking succeeds", async () => {
    const target = await makeSkillDir("canonical-ok");
    const linkPath = join(workDir, "agent-ok");

    const mode = await linkOrCopy(target, linkPath);

    expect(mode).toBe("symlink");
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("canonical body");
  });
});

describe("linkOrCopy — idempotency and stale entries", () => {
  it("is idempotent: a second run leaves the link working", async () => {
    // The original implementation never cleared an existing entry, so `symlink`
    // failed with EEXIST on every re-run and silently degraded to a copy.
    const target = await makeSkillDir("canonical-twice");
    const linkPath = join(workDir, "agent-twice");

    const first = await linkOrCopy(target, linkPath);
    const second = await linkOrCopy(target, linkPath);

    expect(first).toBe("symlink");
    expect(second).toBe("symlink");
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("canonical body");
  });

  it("replaces a plain directory sitting at the link path", async () => {
    const target = await makeSkillDir("canonical-replace");
    const linkPath = join(workDir, "agent-replace");
    await mkdir(linkPath, { recursive: true });
    await writeFile(join(linkPath, "SKILL.md"), "stale body", "utf8");

    await linkOrCopy(target, linkPath);

    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("canonical body");
  });

  it("repoints a link aimed at the wrong target", async () => {
    const target = await makeSkillDir("canonical-right");
    const wrong = await makeSkillDir("canonical-wrong");
    await writeFile(join(wrong, "SKILL.md"), "wrong body", "utf8");
    const linkPath = join(workDir, "agent-repoint");

    await linkOrCopy(wrong, linkPath);
    await linkOrCopy(target, linkPath);

    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("canonical body");
  });

  it("leaves an already-correct link untouched rather than recreating it", async () => {
    const target = await makeSkillDir("canonical-stable");
    const linkPath = join(workDir, "agent-stable");

    await linkOrCopy(target, linkPath);
    const linkedTo = await readSymlink(linkPath);
    vi.mocked(symlinkMock).mockClear();

    await linkOrCopy(target, linkPath);

    // No second `symlink` call means the existing entry was recognised as
    // already correct rather than torn down and rebuilt.
    expect(vi.mocked(symlinkMock)).not.toHaveBeenCalled();
    expect(await readSymlink(linkPath)).toBe(linkedTo);
  });

  it("short-circuits when the link path already resolves to the target", async () => {
    // Guards the destructive case: if the agent dir is itself a link onto the
    // canonical tree, clearing it would delete the canonical copy.
    const target = await makeSkillDir("canonical-same");

    const mode = await linkOrCopy(target, target);

    expect(mode).toBe("symlink");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("canonical body");
  });

  it.skipIf(isWindows)("clears a dangling symlink instead of failing with EEXIST", async () => {
    const target = await makeSkillDir("canonical-dangling");
    const linkPath = join(workDir, "agent-dangling");
    const { symlink: realSymlink } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await realSymlink(join(workDir, "does-not-exist"), linkPath, "dir");

    const mode = await linkOrCopy(target, linkPath);

    expect(mode).toBe("symlink");
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("canonical body");
  });
});

describe("canonicalSkillsDir", () => {
  it("resolves the project canonical dir under the working directory", () => {
    expect(canonicalSkillsDir(false, workDir)).toBe(join(workDir, ".agents", "skills"));
  });

  it("resolves the global canonical dir under the home directory", () => {
    const dir = canonicalSkillsDir(true, workDir);
    expect(dir.endsWith(join(".agents", "skills"))).toBe(true);
    expect(dir.startsWith(workDir)).toBe(false);
  });
});

describe("hookScriptCommand — Git Bash escaping", () => {
  it("converts backslashes to forward slashes so Git Bash does not eat them", () => {
    // Git Bash treats `\` as an escape character: C:\Users\me\x collapses to
    // C:Usersmex and the hook dies with "command not found".
    expect(hookScriptCommand("C:\\Users\\me\\.claude\\bluud\\bluud-pull-hook.cmd")).toBe(
      '"C:/Users/me/.claude/bluud/bluud-pull-hook.cmd"',
    );
  });

  it("quotes the path so a directory containing a space still resolves", () => {
    expect(hookScriptCommand("C:\\Program Files\\bluud\\hook.cmd")).toBe(
      '"C:/Program Files/bluud/hook.cmd"',
    );
  });

  it("leaves an already-POSIX path alone apart from quoting", () => {
    expect(hookScriptCommand("/home/dev/.claude/bluud/bluud-pull-hook.sh")).toBe(
      '"/home/dev/.claude/bluud/bluud-pull-hook.sh"',
    );
  });

  it.each([
    ["a double quote", 'C:\\Users\\me"x\\hook.cmd'],
    ["a dollar sign", "C:\\Users\\$me\\hook.cmd"],
    ["a backtick", "C:\\Users\\me`x\\hook.cmd"],
    ["a newline", "C:\\Users\\me\nx\\hook.cmd"],
  ])("refuses a path containing %s", (_label, path) => {
    // Each of these is expanded or re-parsed inside the double quotes the
    // command is stored with, corrupting it silently at session start.
    expect(() => hookScriptCommand(path)).toThrow(/cannot be safely quoted/);
  });

  it("reports refusal as null through the OrNull variant so `doctor` stays total", () => {
    expect(hookScriptCommandOrNull("C:\\Users\\$me\\hook.cmd")).toBeNull();
    expect(hookScriptCommandOrNull("C:\\Users\\me\\hook.cmd")).toBe('"C:/Users/me/hook.cmd"');
  });
});

describe("atomicWriteFile — Windows sharing violations", () => {
  it("retries a rename that fails with a transient EPERM", async () => {
    // MoveFileEx fails with ERROR_ACCESS_DENIED while an editor, antivirus, or
    // indexer holds the destination open; the holder releases in milliseconds.
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const target = join(workDir, "settings.json");
    let attempts = 0;
    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
          code: "EPERM",
        });
      }
      return actual.rename(from, to);
    });

    await atomicWriteFile(target, "{}\n");

    expect(attempts).toBe(3);
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it("gives up and reports the cause when the rename never succeeds", async () => {
    const target = join(workDir, "locked.json");
    vi.mocked(renameMock).mockRejectedValue(
      Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" }),
    );

    await expect(atomicWriteFile(target, "{}\n")).rejects.toThrow(/Failed to write/);

    // The temp file is cleaned up rather than left as debris.
    const { readdir } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const leftovers = await readdir(workDir);
    expect(leftovers.filter((n) => n.includes(".bluud.tmp-"))).toEqual([]);
  });

  it("does not retry a non-transient rename failure", async () => {
    // A genuine permissions problem must surface immediately, not after ten
    // rounds of backoff.
    const target = join(workDir, "nope.json");
    let attempts = 0;
    vi.mocked(renameMock).mockImplementation(async () => {
      attempts += 1;
      throw Object.assign(new Error("EROFS: read-only file system, rename"), { code: "EROFS" });
    });

    await expect(atomicWriteFile(target, "{}\n")).rejects.toThrow(/Failed to write/);
    expect(attempts).toBe(1);
  });

  it("writes the temp file beside the destination to keep the rename atomic", async () => {
    // A cross-device rename degrades to a copy and loses atomicity, so the temp
    // must never live in the system temp dir.
    const target = join(workDir, "nested", "deep", "settings.json");
    const seen: string[] = [];
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      seen.push(String(from));
      return actual.rename(from, to);
    });

    await atomicWriteFile(target, "payload");

    expect(seen[0]?.startsWith(join(workDir, "nested", "deep"))).toBe(true);
    expect(await readFile(target, "utf8")).toBe("payload");
  });

  it("sweeps stale temp files left by a crashed earlier write", async () => {
    const target = join(workDir, "settings.json");
    const stale = join(workDir, `settings.json.bluud.tmp-deadbeef`);
    await writeFile(stale, "orphan", "utf8");
    // Backdate it past the one-hour staleness threshold.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { utimes } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await utimes(stale, old, old);

    await atomicWriteFile(target, "{}\n");

    expect(existsSync(stale)).toBe(false);
  });

  it("leaves a fresh temp file from a concurrent write alone", async () => {
    const target = join(workDir, "settings.json");
    const fresh = join(workDir, `settings.json.bluud.tmp-cafebabe`);
    await writeFile(fresh, "in flight", "utf8");

    await atomicWriteFile(target, "{}\n");

    expect(existsSync(fresh)).toBe(true);
  });
});

describe("hook script line endings", () => {
  it.skipIf(!isWindows)("writes CRLF for the cmd template on Windows", async () => {
    // cmd.exe parses line-by-line up to a CR; an LF-only .cmd makes it execute
    // fragments of the comment block as commands.
    const { renderHookScript } = await import("../src/lib/adapters/hookScript.js");
    const rendered = renderHookScript("@echo off\nREM bluud:managed\n", {
      binary: "C:/bluud/bluud.cmd",
      format: "",
      posix: false,
    });
    expect(rendered).toContain("\r\n");
    expect(rendered.includes("\n\n")).toBe(false);
  });

  it("writes LF for the sh template regardless of host platform", async () => {
    // A CRLF .sh makes the kernel look for an interpreter literally named `sh\r`.
    const { renderHookScript } = await import("../src/lib/adapters/hookScript.js");
    const rendered = renderHookScript("#!/usr/bin/env sh\r\n# bluud:managed\r\n", {
      binary: "/usr/local/bin/bluud",
      format: "",
      posix: true,
    });
    expect(rendered).not.toContain("\r");
  });
});
