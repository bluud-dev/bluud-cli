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
import { cp, mkdir, rm, symlink, readlink, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import os from "node:os";
import { claudeHome, codexHome } from "./agentHomes.js";
/**
 * The skill's identity. This must equal the `name` in the bundled
 * `SKILL.md` frontmatter: `skills` resolves `--skill <name>` against the
 * frontmatter (`filterSkills` in its `src/skills.ts`), and it rejects outright
 * any SKILL.md whose frontmatter lacks a string `name`/`description`. A
 * mismatch surfaces only as "No valid skills found" at install time, so the
 * value lives here once and is asserted against the file by `skill.test.ts`.
 */
export const BLUUD_SKILL_NAME = "bluud-memory";

export interface SkillsInstallOptions {
  skillName: string;
  skillPath: string;
  agent: string;
  global?: boolean;
  copy?: boolean;
  cwd?: string;
  /** When true, determine what would happen but write nothing (`--dry-run`). */
  dryRun?: boolean;
}

export interface SkillsInstallResult {
  agent: string;
  installed: boolean;
  /**
   * How the skill reached the agent. `skills` means the `npx skills` installer
   * handled it; `symlink`/`copy` are Bluud's own fallback reporting whether the
   * canonical copy was linked into the agent's directory or duplicated into it.
   */
  mode: "skills" | "symlink" | "copy" | "skipped";
  message?: string;
}

/**
 * Try to install a skill via `npx skills`.  If the tool is missing or the call
 * fails, fall back to a direct copy into the agent's canonical skill dir.
 *
 * With `dryRun: true`, this only probes whether `npx skills` would be used
 * (a read-only `commandExists` check) and reports the predicted mode without
 * spawning the installer or touching the filesystem — mirroring the
 * gortex-style `Plan`/`Apply` split the hook adapters already honor.
 */
export async function installSkill(options: SkillsInstallOptions): Promise<SkillsInstallResult> {
  const {
    skillName,
    skillPath,
    agent,
    global = false,
    copy = false,
    cwd = process.cwd(),
    dryRun = false,
  } = options;

  // A tool with no skills-discovery mechanism cannot receive the skill by any
  // route, so neither `skills` nor the local installer is worth attempting —
  // checked before the `npx` probe so the reason reported is the tool's own,
  // not a downstream "unknown agent" error from a subprocess that never had a
  // chance of succeeding.
  const unsupported = skillDeliveryUnsupportedReason(agent);
  if (unsupported) {
    return { agent, installed: false, mode: "skipped", message: unsupported };
  }

  const skillsAvailable = await commandExists("npx");

  if (dryRun) {
    // The link-vs-copy outcome of the local fallback cannot be known without
    // attempting the link, so a dry run reports the mode it would *try*:
    // `copy` when `--copy` forces it, `symlink` otherwise.
    const predictedMode: SkillsInstallResult["mode"] = skillsAvailable
      ? "skills"
      : resolveSkillTargetDir(agent, global, cwd)
        ? copy
          ? "copy"
          : "symlink"
        : "skipped";
    return {
      agent,
      installed: false,
      mode: predictedMode,
      message: "dry run — no changes written",
    };
  }

  if (skillsAvailable) {
    try {
      await runSkillsAdd({ skillPath, agent, global, copy });
      return { agent, installed: true, mode: "skills" };
    } catch (err) {
      // Fall through to manual copy with a warning recorded in the message.
      const message = err instanceof Error ? err.message : String(err);
      if (!copy) {
        // Try the local installer once before giving up.
        return manualCopyInstall({ skillName, skillPath, agent, global, cwd, message });
      }
      // The caller already asked `skills` for a plain copy and it failed, so
      // repeating the same operation locally has nothing new to try.
      return { agent, installed: false, mode: "skipped", message };
    }
  }

  return manualCopyInstall({ skillName, skillPath, agent, global, cwd, forceCopy: copy });
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
    BLUUD_SKILL_NAME,
    "-a",
    options.agent,
    "-y",
  ];
  if (options.global) args.push("-g");
  if (options.copy) args.push("--copy");

  await execFile("npx", args);
}

/**
 * The canonical location a skill's files physically live in, from which every
 * agent's directory is linked. Mirrors `getCanonicalSkillsDir` in
 * `skills/src/installer.ts` and the layout named in
 * `BLUUD_CLI_ARCHITECTURE.md` section 2.2: `.agents/skills` for a project
 * install, `~/.agents/skills` for a global one.
 */
export function canonicalSkillsDir(global: boolean, cwd: string): string {
  return global ? join(os.homedir(), ".agents", "skills") : resolve(cwd, ".agents", "skills");
}

/**
 * Install the skill without `npx skills`: write it once to the canonical
 * directory, then link each agent's directory at that copy.
 *
 * `forceCopy` (the `--copy` flag) skips the canonical indirection entirely and
 * duplicates the files straight into the agent's directory — the documented
 * escape hatch for filesystems where a link is undesirable even when it is
 * possible.
 */
async function manualCopyInstall(options: {
  skillName: string;
  skillPath: string;
  agent: string;
  global: boolean;
  cwd: string;
  forceCopy?: boolean;
  message?: string;
}): Promise<SkillsInstallResult> {
  const targetDir = resolveSkillTargetDir(options.agent, options.global, options.cwd);
  if (!targetDir) {
    const unsupported = skillDeliveryUnsupportedReason(options.agent);
    return {
      agent: options.agent,
      installed: false,
      mode: "skipped",
      message:
        unsupported ?? options.message ?? `No manual install target known for ${options.agent}`,
    };
  }

  const agentSkillDir = join(targetDir, options.skillName);

  try {
    if (options.forceCopy) {
      await rm(agentSkillDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      await cp(options.skillPath, agentSkillDir, { recursive: true });
      return {
        agent: options.agent,
        installed: true,
        mode: "copy",
        message: options.message ? `${options.message} (copy fallback succeeded)` : undefined,
      };
    }

    const canonicalDir = join(canonicalSkillsDir(options.global, options.cwd), options.skillName);

    // Replace rather than merge: a stale file from a previous skill version
    // would otherwise survive into the new install.
    await rm(canonicalDir, { recursive: true, force: true });
    await mkdir(dirname(canonicalDir), { recursive: true });
    await cp(options.skillPath, canonicalDir, { recursive: true });

    // Several tools (Cline, Kimi, Gemini CLI at project scope) already read
    // from `.agents/skills` — for those the canonical copy *is* the agent's
    // copy and linking it to itself would be a no-op at best.
    const mode: LinkMode =
      resolve(agentSkillDir) === resolve(canonicalDir)
        ? "symlink"
        : await linkOrCopy(canonicalDir, agentSkillDir);

    return {
      agent: options.agent,
      installed: true,
      mode,
      message: options.message ? `${options.message} (local install succeeded)` : undefined,
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
 * `skills` itself is unavailable, and every entry is verified against that
 * registry (`skills/src/agents.ts`), which is the authority named by
 * `BLUUD_CLI_ARCHITECTURE.md` section 2.1.
 *
 * **Every target is a directory that holds skill sub-directories** — the
 * install writes `<target>/<skill-name>/SKILL.md`. That invariant is the whole
 * contract of this function. An earlier version listed each tool's *instruction
 * file* instead (`AIDER.md`, `.windsurfrules`, `.github/copilot-instructions.md`,
 * `.cursor/rules`), conflating "where does this tool read prose guidance" with
 * "where does this tool discover skills". Those are different mechanisms, and
 * the mismatch produced nonsense paths like `AIDER.md/bluud-memory/SKILL.md` —
 * a *directory* named `AIDER.md`, which shadows the very file the tool reads.
 *
 * A tool with no skills-discovery mechanism at all therefore does not belong
 * here; see `SKILL_DELIVERY_UNSUPPORTED`.
 */
interface SkillTarget {
  /** Project-relative directory holding skill sub-directories. */
  project: string;
  /** Absolute user-level equivalent, or null when the tool has no global surface. */
  global: string | null;
}

/**
 * Tools Bluud detects but cannot deliver a skill file to, with the reason.
 *
 * Kept explicit rather than simply omitted so `installSkill` can explain the
 * skip instead of emitting the generic "no target known", which reads like a
 * gap in Bluud rather than a property of the tool.
 */
const SKILL_DELIVERY_UNSUPPORTED: Record<string, string> = {
  // Verified against https://aider.chat/docs/usage/conventions.html: aider has
  // no skills directory and loads no instruction file automatically — a
  // conventions file reaches it only through an explicit `--read CONVENTIONS.md`
  // or a `read:` entry in `.aider.conf.yml`. It is correspondingly absent from
  // the `skills` registry's 73 agents (only the separate `aider-desk` appears).
  aider:
    "aider has no skills directory; add the Bluud skill manually with " +
    "`aider --read <path>/SKILL.md` or a `read:` entry in .aider.conf.yml",
};

function skillRegistry(): Record<string, SkillTarget> {
  const home = os.homedir();
  return {
    // Honors CLAUDE_CONFIG_DIR / CODEX_HOME exactly as the tools and the
    // `skills` registry do; a user who relocated their config must not have the
    // skill written to the stock path where the tool will never look.
    "claude-code": { project: ".claude/skills", global: join(claudeHome(), "skills") },
    codex: { project: ".agents/skills", global: join(codexHome(), "skills") },
    "gemini-cli": { project: ".agents/skills", global: join(home, ".gemini", "skills") },
    antigravity: {
      project: ".agents/skills",
      global: join(home, ".gemini", "antigravity", "skills"),
    },
    "kimi-code-cli": { project: ".agents/skills", global: join(home, ".agents", "skills") },
    cline: { project: ".agents/skills", global: join(home, ".agents", "skills") },
    cursor: { project: ".agents/skills", global: join(home, ".cursor", "skills") },
    // `.windsurfrules` is the legacy single-file rules surface, superseded by
    // `.windsurf/`; skills live under `.windsurf/skills`, not in the rules file.
    windsurf: {
      project: ".windsurf/skills",
      global: join(home, ".codeium", "windsurf", "skills"),
    },
    "github-copilot": { project: ".agents/skills", global: join(home, ".copilot", "skills") },
  };
}

/**
 * Why `agent` cannot receive a skill by file delivery, or null when it can.
 * Exposed so callers can surface the tool-specific reason.
 */
export function skillDeliveryUnsupportedReason(agent: string): string | null {
  return SKILL_DELIVERY_UNSUPPORTED[agent] ?? null;
}

export function resolveSkillTargetDir(agent: string, global: boolean, cwd: string): string | null {
  const entry = skillRegistry()[agent];
  if (!entry) return null;

  if (global) {
    return entry.global;
  }
  return resolve(cwd, entry.project);
}

/**
 * Whether the Bluud skill appears installed for `agent` at its known target
 * directory (the same location `installSkill`/`manualCopyInstall` write to).
 * Read-only — used by `bluud doctor` to report per-tool skill-delivery drift
 * without writing anything. Agents with no known manual target (only reached
 * via `npx skills`'s own ~75-tool registry) resolve to `false` rather than
 * throwing, since Bluud has no visibility into that tool's directory layout.
 */
export function isSkillInstalled(agent: string, global: boolean, cwd: string): boolean {
  const targetDir = resolveSkillTargetDir(agent, global, cwd);
  if (!targetDir) return false;
  return existsSync(join(targetDir, BLUUD_SKILL_NAME));
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

/** How a skill directory ended up at its agent-visible location. */
export type LinkMode = "symlink" | "copy";

/**
 * Point `linkPath` at `target`, preferring a link and falling back to a copy.
 *
 * This is the cross-platform core of the canonical-plus-fan-out install that
 * `BLUUD_CLI_ARCHITECTURE.md` section 2.2 adopts from
 * `skills/src/installer.ts` (`createSymlink`, `InstallMode`): one physical copy
 * of the skill de-duplicates across every tool that wants it, while staying
 * functional on filesystems that refuse links.
 *
 * Three platform facts drive the branches:
 *
 * 1. **Windows junctions require an absolute target.** A junction stores a
 *    fully-qualified path; handing `symlink` a relative one resolves it against
 *    the *process* cwd rather than the link's directory, producing a link that
 *    silently points nowhere. POSIX symlinks get a relative target instead, so
 *    the tree survives being moved or mounted at a different prefix.
 * 2. **Junctions, unlike Windows symlinks, need no elevation or Developer
 *    Mode.** That is the whole reason `skills` uses `'junction'` on `win32`
 *    rather than `'dir'` — an unprivileged `symlink` of type `'dir'` fails with
 *    `EPERM` on a default Windows install, which is precisely the copy-fallback
 *    case this function exists to avoid taking unnecessarily.
 * 3. **A stale entry at `linkPath` makes `symlink` fail with `EEXIST`.** Node
 *    will not replace an existing path, so a re-run would fall back to copy
 *    forever. Clearing it first is what makes the link path reachable on the
 *    second and every subsequent `bluud` run.
 *
 * Returns which mode actually succeeded, so callers can report it honestly
 * rather than claiming a link they did not get.
 */
export async function linkOrCopy(target: string, linkPath: string): Promise<LinkMode> {
  const resolvedTarget = resolve(target);
  const resolvedLink = resolve(linkPath);

  // Resolving both through realpath catches the case where the agent's
  // directory is itself a link onto the canonical tree (e.g. `~/.claude/skills`
  // already points at `~/.agents/skills`). Without this check the cleanup below
  // would delete the canonical copy we are about to link to.
  const [realTarget, realLink] = await Promise.all([
    realpath(resolvedTarget).catch(() => resolvedTarget),
    realpath(resolvedLink).catch(() => resolvedLink),
  ]);
  if (realTarget === realLink) {
    return "symlink";
  }

  await clearLinkPath(resolvedLink, resolvedTarget);

  try {
    await mkdir(dirname(resolvedLink), { recursive: true });
    if (process.platform === "win32") {
      await symlink(resolvedTarget, resolvedLink, "junction");
    } else {
      await symlink(relative(dirname(resolvedLink), resolvedTarget), resolvedLink, "dir");
    }
    return "symlink";
  } catch {
    // Restrictive filesystem, missing privileges, or a network share that does
    // not support reparse points. A copy is a complete install — only the
    // de-duplication is lost — so this degrades rather than failing.
    await cp(resolvedTarget, resolvedLink, { recursive: true });
    return "copy";
  }
}

/**
 * Remove whatever occupies `linkPath` so a fresh link can be created, leaving
 * an already-correct link in place.
 *
 * A broken or circular link is the important case: `lstat` succeeds on a
 * dangling symlink (it does not follow it) but `readlink` on a circular one
 * raises `ELOOP`, and either way the entry must go or `symlink` will fail with
 * `EEXIST`. Removal is best-effort — if it fails, `symlink` fails too and the
 * caller takes the copy path.
 */
async function clearLinkPath(linkPath: string, expectedTarget: string): Promise<void> {
  try {
    const stats = await lstat(linkPath);
    if (stats.isSymbolicLink()) {
      const existing = await readlink(linkPath).catch(() => null);
      if (existing !== null) {
        const existingAbsolute = isAbsolute(existing)
          ? existing
          : resolve(dirname(linkPath), existing);
        if (resolve(existingAbsolute) === expectedTarget) {
          // Already correct; leave it so the mtime does not churn.
          return;
        }
      }
      await rm(linkPath, { force: true, recursive: true });
      return;
    }
    await rm(linkPath, { force: true, recursive: true });
  } catch {
    // ENOENT is the common path (nothing to clear). Anything else is left for
    // `symlink` to surface via the copy fallback.
    await rm(linkPath, { force: true, recursive: true }).catch(() => undefined);
  }
}

/**
 * Backwards-compatible alias retained because the hook adapters and tests refer
 * to it by this name. `linkOrCopy` carries the return value; this wrapper keeps
 * the void-returning shape for call sites that do not care which mode won.
 */
export async function createSymlinkOrCopy(target: string, linkPath: string): Promise<void> {
  await linkOrCopy(target, linkPath);
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
  return bundledAssetPath("skill");
}

/**
 * Absolute path to the bundled hook-script templates (`bluud-pull-hook.sh` /
 * `bluud-pull-hook.cmd`). These are package assets read at install time and
 * materialized into each tool's own config directory — they are never executed
 * from here, because the package directory is volatile under `npx` (see
 * `hookScript.ts`).
 */
export function bundledHooksPath(): string {
  return bundledAssetPath("hooks");
}

/**
 * Resolve a directory shipped alongside the bundle. `dist/<name>` is preferred
 * (what `tsup` emits and what `package.json#files` publishes); `src/<name>` is
 * the fallback for running straight from a source checkout.
 */
function bundledAssetPath(name: string): string {
  const packageRoot = findPackageRoot();
  const candidates = [resolve(packageRoot, "dist", name), resolve(packageRoot, "src", name)];
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
