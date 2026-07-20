/**
 * Skill-delivery target registry and the `installSkill` decision matrix.
 *
 * Two invariants are enforced here.
 *
 * 1. **Every target is a directory of skill sub-directories.** The install
 *    writes `<target>/<skill>/SKILL.md`, so a target that names a tool's
 *    *instruction file* (`AIDER.md`, `.windsurfrules`,
 *    `.github/copilot-instructions.md`) is a bug: it creates a directory where
 *    the tool expects a file to read, shadowing it. Every entry is checked
 *    against `skills/src/agents.ts`, the authority named by
 *    BLUUD_CLI_ARCHITECTURE.md §2.1.
 * 2. **`installSkill`'s route is fully specified.** Every combination of "is
 *    npx present", "did `skills add` fail", and "was `--copy` passed" has an
 *    asserted outcome, so no branch changes silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join, isAbsolute } from "node:path";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import {
  installSkill,
  resolveSkillTargetDir,
  skillDeliveryUnsupportedReason,
  isSkillInstalled,
  BLUUD_SKILL_NAME,
} from "../src/lib/skills.js";
import { claudeHome, codexHome } from "../src/lib/agentHomes.js";

const mockedSpawn = vi.mocked(spawn);

/** Agents Bluud offers in `install.ts` / `doctor.ts` SUPPORTED_AGENTS. */
const SUPPORTED_AGENTS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "antigravity",
  "kimi-code-cli",
  "cline",
  "cursor",
  "windsurf",
  "aider",
  "github-copilot",
];

/**
 * Project-relative skill directories as declared by `skills/src/agents.ts`
 * (read directly from the vendored copy in `org/repos/skills`). `windsurf` uses
 * its own `.windsurf/skills`; the rest of the non-Claude tools share the
 * universal `.agents/skills`.
 */
const EXPECTED_PROJECT_DIR: Record<string, string> = {
  "claude-code": join(".claude", "skills"),
  codex: join(".agents", "skills"),
  "gemini-cli": join(".agents", "skills"),
  antigravity: join(".agents", "skills"),
  "kimi-code-cli": join(".agents", "skills"),
  cline: join(".agents", "skills"),
  cursor: join(".agents", "skills"),
  windsurf: join(".windsurf", "skills"),
  "github-copilot": join(".agents", "skills"),
};

function makeChild(opts: { exitCode?: number | null; stderr?: string } = {}) {
  const { exitCode = 0, stderr = "" } = opts;
  return {
    stdout: { on: () => undefined },
    stderr: {
      on: (event: string, handler: (chunk?: unknown) => void) => {
        if (event === "data" && stderr) queueMicrotask(() => handler(Buffer.from(stderr, "utf8")));
      },
    },
    on: (event: string, handler: (arg?: unknown) => void) => {
      if (event === "exit") queueMicrotask(() => handler(exitCode));
    },
  } as unknown as ReturnType<typeof spawn>;
}

function routeSpawn(opts: { npxAvailable: boolean; skillsAddExit?: number; stderr?: string }) {
  mockedSpawn.mockImplementation(((command: string) => {
    if (command === "where" || command === "which") {
      return makeChild({ exitCode: opts.npxAvailable ? 0 : 1 });
    }
    if (command === "npx") {
      return makeChild({ exitCode: opts.skillsAddExit ?? 0, stderr: opts.stderr });
    }
    return makeChild({ exitCode: 0 });
  }) as unknown as typeof spawn);
}

let skillPath: string;
let workDir: string;

beforeEach(async () => {
  mockedSpawn.mockReset();
  skillPath = await mkdtemp(join(tmpdir(), "bluud-target-src-"));
  await writeFile(join(skillPath, "SKILL.md"), "# Bluud Memory Skill\n", "utf8");
  workDir = await mkdtemp(join(tmpdir(), "bluud-target-cwd-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(skillPath, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe("resolveSkillTargetDir — every target is a skills directory", () => {
  it.each(Object.entries(EXPECTED_PROJECT_DIR))(
    "%s resolves to the %s directory declared by the skills registry",
    (agent, expected) => {
      expect(resolveSkillTargetDir(agent, false, workDir)).toBe(join(workDir, expected));
    },
  );

  it.each(Object.keys(EXPECTED_PROJECT_DIR))(
    "%s has an absolute global target too (no tool loses its user-level surface)",
    (agent) => {
      const dir = resolveSkillTargetDir(agent, true, workDir);
      expect(dir).not.toBeNull();
      expect(isAbsolute(dir as string)).toBe(true);
      expect((dir as string).endsWith("skills")).toBe(true);
    },
  );

  it.each(Object.keys(EXPECTED_PROJECT_DIR))(
    "%s never targets an instruction FILE (the AIDER.md/.windsurfrules class of bug)",
    (agent) => {
      // The install appends `/<skill>/SKILL.md`, so any target whose last
      // segment carries a file extension would create a directory where the
      // tool expects a readable file.
      for (const dir of [
        resolveSkillTargetDir(agent, false, workDir),
        resolveSkillTargetDir(agent, true, workDir),
      ]) {
        expect(dir).not.toBeNull();
        const last = (dir as string).split(/[\\/]/).pop() as string;
        expect(last).not.toMatch(/\.(md|json|ya?ml|toml)$/i);
      }
    },
  );

  it("returns null for an agent that is not in the registry", () => {
    expect(resolveSkillTargetDir("totally-unknown-agent", false, workDir)).toBeNull();
  });

  it("honors CLAUDE_CONFIG_DIR for the global Claude Code target", () => {
    // A user who relocated their config must not get the skill written to the
    // stock path the tool will never read.
    const relocated = join(workDir, "custom-claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", relocated);
    expect(claudeHome()).toBe(relocated);
    expect(resolveSkillTargetDir("claude-code", true, workDir)).toBe(join(relocated, "skills"));
  });

  it("honors CODEX_HOME for the global Codex target", () => {
    const relocated = join(workDir, "custom-codex");
    vi.stubEnv("CODEX_HOME", relocated);
    expect(codexHome()).toBe(relocated);
    expect(resolveSkillTargetDir("codex", true, workDir)).toBe(join(relocated, "skills"));
  });

  it("falls back to the conventional homes when no override is set", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CODEX_HOME", "");
    expect(claudeHome()).toBe(join(os.homedir(), ".claude"));
    expect(codexHome()).toBe(join(os.homedir(), ".codex"));
  });
});

describe("skill delivery for tools with no skills mechanism", () => {
  it("reports aider as unsupported with an actionable reason", () => {
    // Verified against https://aider.chat/docs/usage/conventions.html — aider
    // auto-loads nothing; a conventions file needs an explicit --read.
    const reason = skillDeliveryUnsupportedReason("aider");
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/--read|aider\.conf\.yml/);
  });

  it("returns no reason for a tool that does support skills", () => {
    expect(skillDeliveryUnsupportedReason("claude-code")).toBeNull();
  });

  it("skips aider without spawning `skills add`, even when npx is available", async () => {
    routeSpawn({ npxAvailable: true });

    const result = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "aider",
      cwd: workDir,
    });

    expect(result.installed).toBe(false);
    expect(result.mode).toBe("skipped");
    expect(result.message).toMatch(/--read|aider\.conf\.yml/);
    // No subprocess at all: the tool could never have accepted the skill.
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("creates no AIDER.md path artefact of any kind", async () => {
    routeSpawn({ npxAvailable: false });

    await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "aider",
      cwd: workDir,
    });

    // The regression this whole change exists to prevent: a *directory* named
    // AIDER.md containing the skill.
    expect(existsSync(join(workDir, "AIDER.md"))).toBe(false);
  });
});

describe("local install writes a real skill directory for every supported tool", () => {
  it.each(Object.keys(EXPECTED_PROJECT_DIR))(
    "%s ends up with a readable SKILL.md under its registry directory",
    async (agent) => {
      routeSpawn({ npxAvailable: false });

      const result = await installSkill({
        skillName: BLUUD_SKILL_NAME,
        skillPath,
        agent,
        cwd: workDir,
      });

      expect(result.installed).toBe(true);
      const targetDir = resolveSkillTargetDir(agent, false, workDir) as string;
      const skillDir = join(targetDir, BLUUD_SKILL_NAME);

      // A directory, holding the skill file, reachable through whichever of
      // link or copy the filesystem allowed.
      expect(statSync(skillDir).isDirectory()).toBe(true);
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("Bluud Memory Skill");
      // And `doctor` agrees the skill is installed.
      expect(isSkillInstalled(agent, false, workDir)).toBe(true);
    },
  );

  it("reports the skill as not installed before any install runs", () => {
    expect(isSkillInstalled("claude-code", false, workDir)).toBe(false);
  });

  it("reports not-installed for an unsupported tool rather than throwing", () => {
    expect(isSkillInstalled("aider", false, workDir)).toBe(false);
  });

  it("covers every agent offered in SUPPORTED_AGENTS", () => {
    // Guards against a tool being added to the CLI's menu without a decision
    // about how (or whether) the skill reaches it.
    for (const agent of SUPPORTED_AGENTS) {
      const hasTarget = resolveSkillTargetDir(agent, false, workDir) !== null;
      const documentedUnsupported = skillDeliveryUnsupportedReason(agent) !== null;
      expect(hasTarget || documentedUnsupported).toBe(true);
    }
  });
});

describe("installSkill decision matrix", () => {
  it("npx present, skills succeeds -> mode 'skills'", async () => {
    routeSpawn({ npxAvailable: true, skillsAddExit: 0 });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });
    expect(r).toEqual({ agent: "claude-code", installed: true, mode: "skills" });
  });

  it("npx present, skills fails, no --copy -> local install succeeds", async () => {
    routeSpawn({ npxAvailable: true, skillsAddExit: 1, stderr: "skills: network down" });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });
    expect(r.installed).toBe(true);
    expect(["symlink", "copy"]).toContain(r.mode);
    expect(r.message).toContain("skills: network down");
  });

  it("npx present, skills fails, --copy -> skipped (deliberate: no local retry)", async () => {
    // Documented decision predating Phase 15: having already asked `skills` for
    // a plain copy, repeating it locally has nothing new to try.
    routeSpawn({ npxAvailable: true, skillsAddExit: 1, stderr: "skills: boom" });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      copy: true,
      cwd: workDir,
    });
    expect(r.installed).toBe(false);
    expect(r.mode).toBe("skipped");
    expect(r.message).toContain("skills: boom");
  });

  it("npx absent, no --copy -> canonical dir plus fan-out", async () => {
    routeSpawn({ npxAvailable: false });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    });
    expect(r.installed).toBe(true);
    expect(existsSync(join(workDir, ".agents", "skills", BLUUD_SKILL_NAME, "SKILL.md"))).toBe(true);
    expect(existsSync(join(workDir, ".claude", "skills", BLUUD_SKILL_NAME, "SKILL.md"))).toBe(true);
  });

  it("npx absent, --copy -> direct copy, no canonical dir", async () => {
    routeSpawn({ npxAvailable: false });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      copy: true,
      cwd: workDir,
    });
    expect(r.mode).toBe("copy");
    expect(existsSync(join(workDir, ".claude", "skills", BLUUD_SKILL_NAME, "SKILL.md"))).toBe(true);
    expect(existsSync(join(workDir, ".agents", "skills", BLUUD_SKILL_NAME))).toBe(false);
  });

  it("dry run writes nothing and predicts the route", async () => {
    routeSpawn({ npxAvailable: false });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      cwd: workDir,
      dryRun: true,
    });
    expect(r.installed).toBe(false);
    expect(r.mode).toBe("symlink");
    expect(existsSync(join(workDir, ".claude"))).toBe(false);
    expect(existsSync(join(workDir, ".agents"))).toBe(false);
  });

  it("dry run reports skipped for a tool that cannot receive skills", async () => {
    routeSpawn({ npxAvailable: true });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "aider",
      cwd: workDir,
      dryRun: true,
    });
    expect(r.mode).toBe("skipped");
  });

  it("a tool sharing .agents/skills installs without linking a directory to itself", async () => {
    // cline's project target IS the canonical dir; the install must recognise
    // that instead of trying to link it onto itself.
    routeSpawn({ npxAvailable: false });
    const r = await installSkill({
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "cline",
      cwd: workDir,
    });
    expect(r.installed).toBe(true);
    expect(
      await readFile(join(workDir, ".agents", "skills", BLUUD_SKILL_NAME, "SKILL.md"), "utf8"),
    ).toContain("Bluud Memory Skill");
  });

  it("is idempotent: installing twice leaves a working skill directory", async () => {
    routeSpawn({ npxAvailable: false });
    const opts = {
      skillName: BLUUD_SKILL_NAME,
      skillPath,
      agent: "claude-code",
      cwd: workDir,
    };
    await installSkill(opts);
    const second = await installSkill(opts);

    expect(second.installed).toBe(true);
    expect(
      await readFile(join(workDir, ".claude", "skills", BLUUD_SKILL_NAME, "SKILL.md"), "utf8"),
    ).toContain("Bluud Memory Skill");
  });
});
