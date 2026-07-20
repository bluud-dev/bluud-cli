/**
 * Materialization of the bundled Bluud hook scripts.
 *
 * Every hook-capable tool ultimately needs the same thing at session start:
 * run `bluud pull --inject` and hand its stdout to the agent. Two constraints
 * make a plain inline command the wrong thing to store in a tool's config:
 *
 * 1. **The `bluud` path is volatile.** Under `npx bluud` the executable lives
 *    in the npx cache, which is pruned. gortex hit the same problem and heals
 *    it after the fact (`HookCommandPathIsEphemeral` in
 *    `internal/agents/claudecode/hooks.go` rewrites hook entries whose binary
 *    no longer resolves). Bluud avoids needing the cure: the tool's config
 *    references a **script in the tool's own config directory**, which never
 *    moves, and only the script body carries the volatile path. Every `bluud`
 *    run rewrites the body, so the path self-heals without ever touching the
 *    user's settings file again.
 *
 * 2. **A failed pull must not break the session.** BLUUD_CONCEPT.md section
 *    9.1 requires the agent to proceed without memory when a pull fails. A
 *    bare `bluud pull --inject` exits non-zero on a missing token or a network
 *    error, which the hook-capable tools report as a broken hook — and for the
 *    tools whose hook contract parses stdout as JSON (Gemini CLI, Cline) a
 *    non-zero exit is worse than useless. The script wrapper swallows the exit
 *    code, forwards the diagnostic to stderr, and exits 0 with empty stdout.
 *
 * The scripts are authored artifacts shipped in the package (`src/hooks/`),
 * not strings built here: `renderHookScript` only substitutes the two
 * placeholders. A file that does not carry the `bluud:managed` marker is
 * treated as user-authored and is never overwritten or removed — the
 * file-level analog of "merge preserving user keys" for a format that has no
 * merge points.
 */

import { chmod, readFile, rm, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { bundledHooksPath } from "../skills.js";
import { atomicWriteFile, readTextFile } from "./writer.js";
import type { AdapterEnv } from "./types.js";

/** `--format` value for `bluud pull --inject`; empty means plain Markdown. */
export type HookScriptFormat = "" | "gemini" | "cline";

const MANAGED_MARKER = "bluud:managed";
/** Name of the per-tool directory Bluud materializes its scripts into. */
export const BLUUD_DIR_NAME = "bluud";
const POSIX_TEMPLATE = "bluud-pull-hook.sh";
const WINDOWS_TEMPLATE = "bluud-pull-hook.cmd";

const BINARY_PLACEHOLDER = "@BLUUD_BINARY@";
const FORMAT_PLACEHOLDER = "@BLUUD_FORMAT@";

export interface HookScriptSpec {
  /** Tool-owned directory the script is written into. */
  dir: string;
  /** File name to write. Defaults to the platform template's own name. */
  fileName?: string;
  /** `--format` passed to `bluud pull --inject`. */
  format?: HookScriptFormat;
  /**
   * Force the POSIX template regardless of the host platform. Set by adapters
   * whose tool only supports unix hooks (Cline), so the script content is
   * correct even if the template is rendered on Windows for a test.
   */
  posix?: boolean;
}

export interface HookScriptPlan {
  /** Absolute path the script would occupy. */
  path: string;
  /** True when a file already exists at `path`. */
  present: boolean;
  /** True when an existing file is not Bluud-managed and must not be touched. */
  foreign: boolean;
  /** True when applying would create or rewrite the script. */
  wouldChange: boolean;
}

/**
 * True when `content` carries the managed marker on a line of its own.
 *
 * The marker can never be line 1 — the shebang must hold that position for the
 * OS to pick the right interpreter, and `@echo off` must hold it on Windows so
 * cmd does not echo the script — so this matches whole lines rather than a
 * prefix. Both comment syntaxes are accepted because the two templates use
 * different ones for the same marker.
 */
export function isManagedByBluud(content: string): boolean {
  return content.split("\n").some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      return trimmed.slice(1).trim() === MANAGED_MARKER;
    }
    if (/^rem\b/i.test(trimmed)) {
      return trimmed.slice(3).trim() === MANAGED_MARKER;
    }
    return false;
  });
}

/** The template file name for a given target platform. */
export function hookScriptFileName(posix: boolean): string {
  return posix ? POSIX_TEMPLATE : WINDOWS_TEMPLATE;
}

/** Whether the POSIX template applies, honoring a spec's explicit override. */
function usePosixTemplate(spec: HookScriptSpec): boolean {
  return spec.posix ?? process.platform !== "win32";
}

function resolveScriptPath(spec: HookScriptSpec): string {
  return join(spec.dir, spec.fileName ?? hookScriptFileName(usePosixTemplate(spec)));
}

async function readTemplate(posix: boolean): Promise<string> {
  return readFile(join(bundledHooksPath(), hookScriptFileName(posix)), "utf8");
}

/**
 * Substitute the two placeholders in a hook-script template.
 *
 * The binary path is embedded inside a quoted shell/cmd assignment, so a value
 * carrying the quoting character would break out of it. Rather than attempt to
 * escape a path that realistically never contains these characters, this
 * rejects it outright — a corrupted hook script fails silently at session
 * start, which is precisely the class of failure worth refusing up front.
 */
export function renderHookScript(
  template: string,
  options: { binary: string; format: HookScriptFormat; posix: boolean },
): string {
  const { binary, format, posix } = options;

  if (/[\r\n]/.test(binary)) {
    throw new Error("Refusing to write a hook script: the bluud path contains a line break.");
  }
  if (posix && binary.includes("'")) {
    throw new Error("Refusing to write a hook script: the bluud path contains a single quote.");
  }
  if (!posix && (binary.includes('"') || binary.includes("%"))) {
    throw new Error('Refusing to write a hook script: the bluud path contains a `"` or `%`.');
  }

  const substituted = template
    .split(BINARY_PLACEHOLDER)
    .join(binary)
    .split(FORMAT_PLACEHOLDER)
    .join(format);

  return normalizeLineEndings(substituted, posix);
}

/**
 * Force the line endings each interpreter actually requires.
 *
 * Neither script tolerates the wrong ending, and both are silent failures:
 * cmd.exe parses a `.cmd` line-by-line up to a CR, so an LF-only file makes it
 * execute fragments of the comment block as commands; and a CRLF `.sh` makes
 * the kernel look for an interpreter literally named `sh\r`, which does not
 * exist. Git checkout settings, `core.autocrlf`, editors, and archive tooling
 * all rewrite line endings, so the templates are normalized here at render
 * time rather than trusting whatever reached disk.
 */
function normalizeLineEndings(text: string, posix: boolean): string {
  const lf = text.replace(/\r\n/g, "\n");
  return posix ? lf : lf.replace(/\n/g, "\r\n");
}

/**
 * Read-only projection of what `applyHookScript` would do. Pure with respect
 * to the filesystem, so it can back `bluud doctor` and `--dry-run`.
 */
export async function planHookScript(
  env: AdapterEnv,
  spec: HookScriptSpec,
): Promise<HookScriptPlan> {
  const path = resolveScriptPath(spec);
  const existing = await readTextFile(path);
  const present = existing !== null;
  const foreign = present && !isManagedByBluud(existing);

  if (foreign) {
    return { path, present, foreign, wouldChange: false };
  }

  const posix = usePosixTemplate(spec);
  let desired: string;
  try {
    desired = renderHookScript(await readTemplate(posix), {
      binary: env.bluudBinary,
      format: spec.format ?? "",
      posix,
    });
  } catch {
    // An unreadable template or an unquotable binary path means there is
    // nothing this adapter can legitimately write; report no pending change
    // rather than promising one that `apply` will refuse.
    return { path, present, foreign, wouldChange: false };
  }

  return { path, present, foreign, wouldChange: existing !== desired };
}

/**
 * Write the hook script for `spec`, returning its absolute path, or `null`
 * when an existing user-authored file blocks the write.
 *
 * Re-writing an already-identical script is skipped so the file's mtime does
 * not churn on every `bluud` run.
 */
export async function applyHookScript(
  env: AdapterEnv,
  spec: HookScriptSpec,
): Promise<string | null> {
  const path = resolveScriptPath(spec);
  const existing = await readTextFile(path);
  if (existing !== null && !isManagedByBluud(existing)) {
    return null;
  }

  const posix = usePosixTemplate(spec);
  const content = renderHookScript(await readTemplate(posix), {
    binary: env.bluudBinary,
    format: spec.format ?? "",
    posix,
  });

  if (existing !== content) {
    await atomicWriteFile(path, content);
  }

  // Always assert the mode: `atomicWriteFile` creates at 0o644, and a script
  // restored from a backup or copied across filesystems can lose the bit even
  // when its content is already correct.
  if (posix) {
    await chmod(path, 0o755);
  }

  return path;
}

/**
 * Remove a previously materialized hook script. Returns true when a file was
 * actually deleted; a missing file or a user-authored one is left alone.
 *
 * The containing directory is removed too when it is Bluud's own and becomes
 * empty, so an uninstall does not leave an orphaned `bluud/` folder behind.
 */
export async function removeHookScript(path: string): Promise<boolean> {
  const existing = await readTextFile(path);
  if (existing === null || !isManagedByBluud(existing)) return false;

  await rm(path, { force: true });

  const parent = dirname(path);
  if (basename(parent) === BLUUD_DIR_NAME && existsSync(parent)) {
    // Succeeds only when the directory is empty; a user file inside it keeps
    // the directory (and their file) intact.
    await rmdir(parent).catch(() => undefined);
  }

  return true;
}

/**
 * Characters that a hook path cannot contain, because the command string is
 * embedded in a tool's config and executed through a shell.
 *
 * Each is a *silent* corruption rather than a loud error, which is why they are
 * refused up front instead of escaped:
 *
 *   - `"` terminates the quoting this function adds, so the remainder of the
 *     path becomes separate shell words.
 *   - `$` and a backtick are expanded inside double quotes by Git Bash (and
 *     every POSIX shell): `C:/Users/$env/…` resolves to `C:/Users//…`. Single
 *     quotes would suppress that, but cmd.exe does not treat single quotes as
 *     quoting at all, and the same command string has to survive both shells.
 *   - A newline splits the stored command into two commands.
 *
 * A refused path is reported to the caller, which skips wiring that tool rather
 * than writing a hook that fails at session start with a message pointing at a
 * path the user never typed.
 */
const UNSAFE_COMMAND_CHARS = /["`$\r\n]/;

/**
 * The command a tool's config should store to invoke `path`.
 *
 * Backslashes are replaced unconditionally, following gortex's
 * `shellSafeHookBinary`: hooks are executed through a shell, and on Windows
 * that shell is often Git Bash, where a backslash is an escape character that
 * silently mangles `C:\Users\me\…` into `C:Usersme…`. Forward slashes survive
 * both cmd.exe and Git Bash — Git Bash maps `C:/Users/...` back to a native
 * path when it spawns the script. The path is quoted so a directory containing
 * a space still resolves under both shells.
 *
 * Throws when the path contains a character that quoting cannot make safe.
 */
export function hookScriptCommand(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (UNSAFE_COMMAND_CHARS.test(normalized)) {
    throw new Error(
      `Refusing to write a hook command: the path ${path} contains a character ` +
        'that cannot be safely quoted for a shell (one of " ` $ or a line break).',
    );
  }
  return `"${normalized}"`;
}

/**
 * `hookScriptCommand` that reports failure as `null` instead of throwing.
 *
 * The plan/detect side of an adapter must stay total: `bluud doctor` runs over
 * every tool and reports drift, so one tool whose path is unquotable has to
 * degrade to "nothing to change here" rather than abort the whole readout.
 */
export function hookScriptCommandOrNull(path: string): string | null {
  try {
    return hookScriptCommand(path);
  } catch {
    return null;
  }
}
