/**
 * Integration with the `skills` CLI for skill delivery.
 *
 * `skills` is a subprocess, not a library, so Bluud shells out to `npx skills`
 * to install the bundled Bluud skill into detected AI tools.
 *
 * If `skills` is unavailable, Bluud falls back to a direct copy-to-canonical
 * install so the CLI remains functional in restricted environments.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, rm, symlink, readlink, lstat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import os from "node:os";
export interface SkillsInstallOptions {
  skillName: string;
  skillPath: string;
  agent: string;
  global?: boolean;
  copy?: boolean;
  cwd?: string;
}

export interface SkillsInstallResult {
  agent: string;
  installed: boolean;
  mode: "skills" | "copy" | "skipped";
  message?: string;
}

/**
 * Try to install a skill via `npx skills`.  If the tool is missing or the call
 * fails, fall back to a direct copy into the agent's canonical skill dir.
 */
export async function installSkill(options: SkillsInstallOptions): Promise<SkillsInstallResult> {
  const {
    skillName,
    skillPath,
    agent,
    global = false,
    copy = false,
    cwd = process.cwd(),
  } = options;

  const skillsAvailable = await commandExists("npx");
  if (skillsAvailable) {
    try {
      await runSkillsAdd({ skillPath, agent, global, copy });
      return { agent, installed: true, mode: "skills" };
    } catch (err) {
      // Fall through to manual copy with a warning recorded in the message.
      const message = err instanceof Error ? err.message : String(err);
      if (!copy) {
        // Try manual copy once before giving up.
        return manualCopyInstall({ skillName, skillPath, agent, global, cwd, message });
      }
      return { agent, installed: false, mode: "skipped", message };
    }
  }

  return manualCopyInstall({ skillName, skillPath, agent, global, cwd });
}

async function runSkillsAdd(options: {
  skillPath: string;
  agent: string;
  global: boolean;
  copy: boolean;
}): Promise<void> {
  const args = [
    "skills",
    "add",
    options.skillPath,
    "--skill",
    "bluud-memory",
    "-a",
    options.agent,
    "-y",
  ];
  if (options.global) args.push("-g");
  if (options.copy) args.push("--copy");

  await execFile("npx", args);
}

async function manualCopyInstall(options: {
  skillName: string;
  skillPath: string;
  agent: string;
  global: boolean;
  cwd: string;
  message?: string;
}): Promise<SkillsInstallResult> {
  const targetDir = resolveSkillTargetDir(options.agent, options.global, options.cwd);
  if (!targetDir) {
    return {
      agent: options.agent,
      installed: false,
      mode: "skipped",
      message: options.message ?? `No manual install target known for ${options.agent}`,
    };
  }

  try {
    await rm(join(targetDir, options.skillName), { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    await cp(options.skillPath, join(targetDir, options.skillName), { recursive: true });
    return {
      agent: options.agent,
      installed: true,
      mode: "copy",
      message: options.message ? `${options.message} (copy fallback succeeded)` : undefined,
    };
  } catch (err) {
    return {
      agent: options.agent,
      installed: false,
      mode: "skipped",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve the canonical skill target directory for a known agent.
 *
 * This mirrors the subset of the `skills` agent registry that Bluud needs when
 * `skills` itself is unavailable.  It is intentionally conservative: only the
 * surfaces documented in `BLUUD_CLI_ARCHITECTURE.md` are supported here.
 */
function resolveSkillTargetDir(agent: string, global: boolean, cwd: string): string | null {
  const home = os.homedir();
  const registry: Record<string, { project: string; global: string | null }> = {
    "claude-code": { project: ".claude/skills", global: join(home, ".claude", "skills") },
    codex: { project: ".codex/skills", global: join(home, ".codex", "skills") },
    cursor: { project: ".cursor/rules", global: null },
    windsurf: { project: ".windsurfrules", global: null },
    aider: { project: "AIDER.md", global: null },
    "github-copilot": { project: ".github/copilot-instructions.md", global: null },
  };

  const entry = registry[agent];
  if (!entry) return null;

  if (global) {
    return entry.global;
  }
  return resolve(cwd, entry.project);
}

export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function execFile(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}`));
      }
    });
  });
}

export async function createSymlinkOrCopy(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    await cp(target, linkPath, { recursive: true });
  }
}

export async function readSymlink(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) return null;
    return await readlink(path);
  } catch {
    return null;
  }
}

export function bundledSkillPath(): string {
  const packageRoot = findPackageRoot();
  const candidates = [resolve(packageRoot, "dist", "skill"), resolve(packageRoot, "src", "skill")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: return the first candidate even if missing so callers get a clear error.
  return candidates[0] as string;
}

function findPackageRoot(): string {
  const entry = process.argv[1];
  if (entry) {
    const normalized = resolve(entry);
    // bin/cli.mjs -> package root; dist/cli.mjs -> package root.
    if (normalized.includes(`${sep}bluud-cli${sep}`) || normalized.endsWith(`${sep}bluud-cli`)) {
      const parts = normalized.split(sep);
      const idx = parts.indexOf("bluud-cli");
      if (idx !== -1) return parts.slice(0, idx + 1).join(sep);
    }
  }

  // Fall back to walking up from this module's URL.
  const modulePath = fileURLToPath(import.meta.url);
  let dir = dirname(modulePath);
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(modulePath);
}
