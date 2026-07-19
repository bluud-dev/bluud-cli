import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});

import { spawn } from "node:child_process";
import { symlink as symlinkMock } from "node:fs/promises";
import {
  installSkill,
  commandExists,
  createSymlinkOrCopy,
  readSymlink,
  bundledSkillPath,
} from "../src/lib/skills.js";

const mockedSpawn = vi.mocked(spawn);

interface FakeChildOptions {
  exitCode?: number | null;
  error?: Error;
  stderr?: string;
  stdout?: string;
}

/**
 * Build a fake ChildProcess that emits deterministically on the next
 * microtask, matching how `browser.test.ts` fakes spawn. Supports both the
 * stdio:"ignore" callers (commandExists) and the stdio:"pipe" caller
 * (execFile), which reads child.stdout/child.stderr.
 */
function makeChild(options: FakeChildOptions = {}): ReturnType<typeof spawn> {
  const { exitCode = 0, error, stderr = "", stdout = "" } = options;
  const streamOn = (payload: string) => (event: string, handler: (chunk?: unknown) => void) => {
    if (event === "data" && payload) {
      queueMicrotask(() => handler(Buffer.from(payload, "utf8")));
    }
  };
  return {
    stdout: { on: streamOn(stdout) },
    stderr: { on: streamOn(stderr) },
    on: (event: string, handler: (arg?: unknown) => void) => {
      if (event === "error" && error) {
        queueMicrotask(() => handler(error));
      } else if (event === "exit" && !error) {
        queueMicrotask(() => handler(exitCode));
      }
    },
  } as unknown as ReturnType<typeof spawn>;
}

/**
 * Route spawn calls the way `skills.ts` issues them: a which/where probe for
 * commandExists, and an `npx` invocation for the actual `skills add`.
 */
function routeSpawn(opts: { npxAvailable: boolean; skillsAdd?: FakeChildOptions }) {
  mockedSpawn.mockImplementation(((command: string) => {
    if (command === "where" || command === "which") {
      return makeChild({ exitCode: opts.npxAvailable ? 0 : 1 });
    }
    if (command === "npx") {
      return makeChild(opts.skillsAdd ?? { exitCode: 0 });
    }
    return makeChild({ exitCode: 0 });
  }) as unknown as typeof spawn);
}

let skillPath: string;
let workDir: string;

beforeEach(async () => {
  mockedSpawn.mockReset();
  // A real skill source directory the copy fallback can actually copy.
  skillPath = await mkdtemp(join(tmpdir(), "bluud-skill-src-"));
  await writeFile(join(skillPath, "SKILL.md"), "# Bluud Memory Skill\n", "utf8");
  // A real project cwd so resolveSkillTargetDir writes under a temp path.
  workDir = await mkdtemp(join(tmpdir(), "bluud-skill-cwd-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(skillPath, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe("installSkill via skills subprocess", () => {
  it("installs through `npx skills add` and reports mode 'skills'", async () => {
    routeSpawn({ npxAvailable: true, skillsAdd: { exitCode: 0 } });

    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });

    expect(result).toEqual({ agent: "claude-code", installed: true, mode: "skills" });
    // The exact non-interactive contract from BLUUD_CLI_ARCHITECTURE.md §2.4.
    expect(mockedSpawn).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", skillPath, "--skill", "bluud-memory", "-a", "claude-code", "-y"],
      { stdio: "pipe" },
    );
  });

  it("appends -g and --copy when global and copy are set", async () => {
    routeSpawn({ npxAvailable: true, skillsAdd: { exitCode: 0 } });

    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "codex",
      global: true,
      copy: true,
      cwd: workDir,
    });

    expect(result.mode).toBe("skills");
    const npxCall = mockedSpawn.mock.calls.find((call) => call[0] === "npx");
    expect(npxCall?.[1]).toEqual([
      "skills",
      "add",
      skillPath,
      "--skill",
      "bluud-memory",
      "-a",
      "codex",
      "-y",
      "-g",
      "--copy",
    ]);
  });
});

describe("installSkill copy fallback", () => {
  it("falls back to a real copy when `skills add` fails, reporting mode 'copy'", async () => {
    routeSpawn({
      npxAvailable: true,
      skillsAdd: { exitCode: 1, stderr: "skills: boom" },
    });

    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });

    expect(result.installed).toBe(true);
    expect(result.mode).toBe("copy");
    expect(result.message).toContain("skills: boom");
    // The skill files were actually materialised under the agent's project dir.
    const copied = join(workDir, ".claude", "skills", "bluud-memory", "SKILL.md");
    expect(existsSync(copied)).toBe(true);
    expect(await readFile(copied, "utf8")).toContain("Bluud Memory Skill");
  });

  it("copies directly when npx is unavailable", async () => {
    routeSpawn({ npxAvailable: false });

    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });

    expect(result.mode).toBe("copy");
    expect(mockedSpawn).not.toHaveBeenCalledWith("npx", expect.anything(), expect.anything());
    expect(existsSync(join(workDir, ".claude", "skills", "bluud-memory", "SKILL.md"))).toBe(true);
  });

  it("skips an unknown agent with no known manual target", async () => {
    routeSpawn({ npxAvailable: false });

    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "totally-unknown-agent",
      cwd: workDir,
    });

    expect(result.installed).toBe(false);
    expect(result.mode).toBe("skipped");
    expect(result.message).toContain("totally-unknown-agent");
  });

  it("skips (does not fall back) when the caller already requested --copy and skills fails", async () => {
    routeSpawn({
      npxAvailable: true,
      skillsAdd: { exitCode: 1, stderr: "already copy mode" },
    });

    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "claude-code",
      copy: true,
      cwd: workDir,
    });

    expect(result.installed).toBe(false);
    expect(result.mode).toBe("skipped");
    expect(result.message).toContain("already copy mode");
  });
});

describe("commandExists", () => {
  it("returns true when the probe exits zero", async () => {
    mockedSpawn.mockReturnValue(makeChild({ exitCode: 0 }));
    expect(await commandExists("npx")).toBe(true);
  });

  it("returns false when the probe exits non-zero", async () => {
    mockedSpawn.mockReturnValue(makeChild({ exitCode: 1 }));
    expect(await commandExists("nope")).toBe(false);
  });

  it("returns false when the probe cannot spawn", async () => {
    mockedSpawn.mockReturnValue(makeChild({ exitCode: null, error: new Error("ENOENT") }));
    expect(await commandExists("nope")).toBe(false);
  });
});

describe("createSymlinkOrCopy / readSymlink", () => {
  it("makes the target reachable at the link path (symlink or copy fallback)", async () => {
    const target = join(workDir, "canonical");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "linked", "utf8");
    const linkPath = join(workDir, "linked");

    await createSymlinkOrCopy(target, linkPath);

    expect(existsSync(join(linkPath, "SKILL.md"))).toBe(true);
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("linked");
  });

  it("returns null from readSymlink for a regular directory", async () => {
    const plain = join(workDir, "plain");
    await mkdir(plain, { recursive: true });
    expect(await readSymlink(plain)).toBeNull();
  });

  it("returns null from readSymlink for a missing path", async () => {
    expect(await readSymlink(join(workDir, "does-not-exist"))).toBeNull();
  });

  it("falls back to a recursive copy when symlink() rejects (Windows without Developer Mode/admin, EPERM)", async () => {
    const symlinkSpy = vi
      .mocked(symlinkMock)
      .mockRejectedValueOnce(
        Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" }),
      );

    const target = join(workDir, "canonical-eperm");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "copied-not-linked", "utf8");
    const linkPath = join(workDir, "linked-eperm");

    await createSymlinkOrCopy(target, linkPath);

    const expectedType = process.platform === "win32" ? "junction" : "dir";
    expect(symlinkSpy).toHaveBeenCalledWith(target, linkPath, expectedType);
    // The fallback is a real, independent copy: mutating the target afterward
    // must not affect the link path, which a symlink would have reflected.
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("copied-not-linked");
    await writeFile(join(target, "SKILL.md"), "mutated-after-copy", "utf8");
    expect(await readFile(join(linkPath, "SKILL.md"), "utf8")).toBe("copied-not-linked");

    symlinkSpy.mockRestore();
  });
});

describe("bundledSkillPath", () => {
  it("resolves to an existing bundled skill directory", async () => {
    const resolved = bundledSkillPath();
    expect(basename(resolved)).toBe("skill");
    // The package ships src/skill (and dist/skill after build); one must exist.
    expect(existsSync(resolved)).toBe(true);
    expect((await stat(resolved)).isDirectory()).toBe(true);
    expect(existsSync(join(resolved, "SKILL.md"))).toBe(true);
  });
});
