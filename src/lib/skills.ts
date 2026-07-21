/**
 * Bluud's own native skill-delivery engine.
 *
 * This installs the bundled Bluud skill into a detected AI tool's canonical
 * skills directory and fans it out (symlink, falling back to a copy) into
 * that tool's own directory. It is entirely in-process: nothing here shells
 * out to any external installer, and there is no runtime dependency on
 * `vercel-labs/skills` or any other separate CLI. The per-tool target
 * directories and detection probes this module and `detect.ts` rely on live
 * in `agentRegistry.ts`, reproduced natively from that project's design (see
 * `agentRegistry.ts`'s header and `BLUUD_CLI_ARCHITECTURE.md`'s reconciliation
 * section for the full history of this decision).
 */

import { spawn } from "node:child_process";
import { cp, mkdir, rm, symlink, readlink, lstat, realpath, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { getAgentDefinition } from "./agentRegistry.js";
import { readSkillVersion } from "./skillVersion.js";
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
   * How the skill reached the agent: `symlink` when the canonical copy was
   * linked into the agent's own directory, `copy` when it was duplicated
   * there instead (either because `--copy` was requested, or a link could not
   * be created and the install degraded to a full copy), `skipped` when the
   * tool has no skill-delivery mechanism at all.
   */
  mode: "symlink" | "copy" | "skipped";
  message?: string;
}

/**
 * Install the bundled skill into `agent`'s canonical skills directory and fan
 * it out into the agent's own directory (symlink, or a copy where a link
 * cannot be created).
 *
 * With `dryRun: true`, this reports the route it would take — `copy` when
 * `--copy` forces it, `symlink` otherwise — without touching the filesystem,
 * mirroring the gortex-style `Plan`/`Apply` split the hook adapters already
 * honor.
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
  // route, so it is worth ruling out before anything else — the reason
  // reported is the tool's own, not a generic "unknown agent" error.
  const unsupported = skillDeliveryUnsupportedReason(agent);
  if (unsupported) {
    return { agent, installed: false, mode: "skipped", message: unsupported };
  }

  if (dryRun) {
    const predictedMode: SkillsInstallResult["mode"] = resolveSkillTargetDir(agent, global, cwd)
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

  return manualCopyInstall({ skillName, skillPath, agent, global, cwd, forceCopy: copy });
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
 * Install the skill natively: write it once to the canonical directory, then
 * link the agent's own directory at that copy.
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
}): Promise<SkillsInstallResult> {
  const targetDir = resolveSkillTargetDir(options.agent, options.global, options.cwd);
  if (!targetDir) {
    const unsupported = skillDeliveryUnsupportedReason(options.agent);
    return {
      agent: options.agent,
      installed: false,
      mode: "skipped",
      message: unsupported ?? `No install target known for ${options.agent}`,
    };
  }

  const agentSkillDir = join(targetDir, options.skillName);

  try {
    if (options.forceCopy) {
      await rm(agentSkillDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      await cp(options.skillPath, agentSkillDir, { recursive: true });
      return { agent: options.agent, installed: true, mode: "copy" };
    }

    const canonicalDir = join(canonicalSkillsDir(options.global, options.cwd), options.skillName);

    // Replace rather than merge: a stale file from a previous skill version
    // would otherwise survive into the new install.
    await rm(canonicalDir, { recursive: true, force: true });
    await mkdir(dirname(canonicalDir), { recursive: true });
    await cp(options.skillPath, canonicalDir, { recursive: true });

    // Several tools (Cline, Kimi, Gemini CLI at project scope, and every other
    // "universal" agent) already read from `.agents/skills` — for those the
    // canonical copy *is* the agent's copy and linking it to itself would be
    // a no-op at best.
    const mode: LinkMode =
      resolve(agentSkillDir) === resolve(canonicalDir)
        ? "symlink"
        : await linkOrCopy(canonicalDir, agentSkillDir);

    return { agent: options.agent, installed: true, mode };
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
  // `agentRegistry.ts`'s registry (only the separate `aider-desk` appears there).
  aider:
    "aider has no skills directory; add the Bluud skill manually with " +
    "`aider --read <path>/SKILL.md` or a `read:` entry in .aider.conf.yml",
};

/**
 * Why `agent` cannot receive a skill by file delivery, or null when it can.
 * Exposed so callers can surface the tool-specific reason.
 */
export function skillDeliveryUnsupportedReason(agent: string): string | null {
  return SKILL_DELIVERY_UNSUPPORTED[agent] ?? null;
}

/**
 * Resolve the canonical skill target directory for a known agent, from the
 * native registry in `agentRegistry.ts`.
 *
 * **Every target is a directory that holds skill sub-directories** — the
 * install writes `<target>/<skill-name>/SKILL.md`. That invariant is the whole
 * contract of this function. An earlier version of this codebase listed some
 * tools' *instruction file* instead (`AIDER.md`, `.windsurfrules`,
 * `.github/copilot-instructions.md`, `.cursor/rules`), conflating "where does
 * this tool read prose guidance" with "where does this tool discover skills".
 * Those are different mechanisms, and the mismatch produced nonsense paths
 * like `AIDER.md/bluud-memory/SKILL.md` — a *directory* named `AIDER.md`,
 * which shadows the very file the tool reads.
 *
 * A tool with no skills-discovery mechanism at all therefore does not belong
 * in the registry; see `SKILL_DELIVERY_UNSUPPORTED`.
 */
export function resolveSkillTargetDir(agent: string, global: boolean, cwd: string): string | null {
  const definition = getAgentDefinition(agent);
  if (!definition) return null;

  if (global) {
    return definition.globalSkillsDir ? definition.globalSkillsDir() : null;
  }
  return resolve(cwd, definition.projectSkillsDir);
}

/**
 * Whether the Bluud skill appears installed for `agent` at its known target
 * directory (the same location `installSkill`/`manualCopyInstall` write to).
 * Read-only — used by `bluud doctor` to report per-tool skill-delivery drift
 * without writing anything. An agent absent from the registry resolves to
 * `false` rather than throwing.
 */
export function isSkillInstalled(agent: string, global: boolean, cwd: string): boolean {
  const targetDir = resolveSkillTargetDir(agent, global, cwd);
  if (!targetDir) return false;
  return existsSync(join(targetDir, BLUUD_SKILL_NAME));
}

/**
 * Whether `command` is resolvable on `PATH`. A generic utility — used by
 * `agentRegistry.ts` to detect PATH-only tools like `aider` (a pip-installed
 * CLI with no persistent config directory to probe instead).
 */
export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
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
 * The version pinned into the bundled `SKILL.md` (see `skillVersion.ts`), or
 * `null` when running from an unbuilt source checkout where `dist/skill` does
 * not exist yet and `bundledSkillPath()` falls back to the unstamped
 * `src/skill`. Read-only; used by `bluud doctor` to report which skill
 * version ships with the running CLI.
 */
export async function bundledSkillVersion(): Promise<string | null> {
  try {
    const markdown = await readFile(join(bundledSkillPath(), "SKILL.md"), "utf8");
    return readSkillVersion(markdown);
  } catch {
    return null;
  }
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

/**
 * Nearest ancestor of `startDir` (inclusive) that holds a `package.json`, or
 * `null` if none appears within six levels.
 */
function findManifestDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Whether `dir`'s manifest is Bluud's own, rather than one belonging to a host
 * project or a tool that happens to sit above us in the tree.
 */
function isBluudPackage(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return manifest.name === "bluud";
  } catch {
    return false;
  }
}

function findPackageRoot(): string {
  // `argv[1]` is trusted only when walking up from it lands on Bluud's *own*
  // manifest. Identifying the root by a path segment literally named
  // "bluud-cli" — as this did — is wrong twice over, and both ways bite at
  // once under CI. Under a test runner `argv[1]` is the runner's binary, not
  // ours; and a GitHub checkout lives at `<runner>/work/bluud-cli/bluud-cli`,
  // where an *ancestor* carries the name too, so taking the first match
  // resolved one level above the real root and every bundled asset lookup
  // (`dist/skill`, `dist/hooks`) missed. Reading the manifest is the only
  // check that does not depend on what a directory happens to be called, and
  // it keeps working for the layouts the name match was written for: a source
  // checkout via `bin/cli.mjs`, a global install, and the volatile
  // `_npx/<hash>/node_modules/bluud` directory an `npx` run unpacks into.
  const entry = process.argv[1];
  if (entry) {
    const fromEntry = findManifestDir(dirname(resolve(entry)));
    if (fromEntry !== null && isBluudPackage(fromEntry)) return fromEntry;
  }

  // Fall back to walking up from this module's URL.
  const modulePath = fileURLToPath(import.meta.url);
  return findManifestDir(dirname(modulePath)) ?? dirname(modulePath);
}
