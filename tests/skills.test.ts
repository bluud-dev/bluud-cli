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
}

/**
 * Build a fake ChildProcess that emits deterministically on the next
 * microtask, matching how `browser.test.ts` fakes spawn. `commandExists` is
 * the only remaining caller of `spawn` in `skills.ts`, and it uses
 * `stdio: "ignore"` — no stdout/stderr plumbing needed here anymore.
 */
function makeChild(options: FakeChildOptions = {}): ReturnType<typeof spawn> {
  const { exitCode = 0, error } = options;
  return {
    on: (event: string, handler: (arg?: unknown) => void) => {
      if (event === "error" && error) {
        queueMicrotask(() => handler(error));
      } else if (event === "exit" && !error) {
        queueMicrotask(() => handler(exitCode));
      }
    },
  } as unknown as ReturnType<typeof spawn>;
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

describe("installSkill", () => {
  it("installs to the canonical dir and fans out to the agent dir", async () => {
    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });

    expect(result.installed).toBe(true);
    // Either mode is a complete install; which one wins depends on whether the
    // host filesystem permits links, so the contract is "reachable", not "linked".
    expect(["symlink", "copy"]).toContain(result.mode);
    expect(mockedSpawn).not.toHaveBeenCalled();
    // The files live once in `.agents/skills`…
    expect(existsSync(join(workDir, ".agents", "skills", "bluud-memory", "SKILL.md"))).toBe(true);
    // …and are reachable from the agent's own directory.
    expect(existsSync(join(workDir, ".claude", "skills", "bluud-memory", "SKILL.md"))).toBe(true);
    expect(await readFile(join(workDir, ".claude", "skills", "bluud-memory", "SKILL.md"), "utf8")).toContain(
      "Bluud Memory Skill",
    );
  });

  it("appends -g and --copy semantics for a different agent", async () => {
    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "codex",
      global: true,
      copy: true,
      cwd: workDir,
    });

    expect(result.installed).toBe(true);
    expect(result.mode).toBe("copy");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("copies straight into the agent dir, bypassing the canonical dir, when --copy is set", async () => {
    const result = await installSkill({
      skillName: "bluud-memory",
      skillPath,
      agent: "claude-code",
      copy: true,
      cwd: workDir,
    });

    expect(result.installed).toBe(true);
    expect(result.mode).toBe("copy");
    expect(existsSync(join(workDir, ".claude", "skills", "bluud-memory", "SKILL.md"))).toBe(true);
    // `--copy` is the documented escape hatch for filesystems where the
    // canonical-plus-link indirection is unwanted, so it must not create one.
    expect(existsSync(join(workDir, ".agents", "skills", "bluud-memory"))).toBe(false);
  });

  it("skips an unknown agent with no known manual target", async () => {
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
