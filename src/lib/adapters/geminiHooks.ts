/**
 * Shared Gemini-settings SessionStart hook logic.
 *
 * Antigravity reads Gemini CLI's own `~/.gemini/settings.json` for lifecycle
 * hooks (verified against gortex's `internal/agents/antigravity/adapter.go`,
 * which merges into the identical file/shape as its Gemini CLI adapter). This
 * module is the single place that knows the hook shape so the two adapters
 * (`gemini-cli`, `antigravity`) can never drift or double-register: applying
 * both against the same file is idempotent because they check for the same
 * command string.
 *
 * Schema (verified against
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md):
 *
 *   { "hooks": { "SessionStart": [ { "type": "command", "command": "...", "name"?: "...", "timeout"?: number } ] } }
 *
 * Gemini CLI's SessionStart entries are flat objects (no `matcher`/nested
 * `hooks` wrapper), and — critically — the hook process must print *only* a
 * single JSON object to stdout; any stray plain text breaks Gemini's parser.
 * `bluud pull --inject --index --format=gemini` emits the
 * `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`
 * envelope (see `renderGeminiHookOutput` in `lib/memory.ts`) wrapped around
 * the lightweight index (`renderMemoryIndex`), not the full tree, to satisfy
 * that contract without dumping every node's body before there is a user
 * request to judge relevance against.
 *
 * That contract is also why the entry points at a materialized hook script
 * rather than `bluud` directly: a failed pull must print nothing at all rather
 * than exit non-zero mid-parse. See `hookScript.ts`.
 *
 * Both adapters share `~/.gemini/bluud/`, so the script — like the settings
 * entry — is written once and covers both.
 */

import { join } from "node:path";
import { mergeJsonFile, readTextFile } from "./writer.js";
import {
  BLUUD_DIR_NAME,
  hookScriptCommandOrNull,
  hookScriptFileName,
  type HookScriptSpec,
} from "./hookScript.js";
import type { AdapterEnv } from "./types.js";

export interface GeminiHookEntry {
  type: "command";
  command: string;
  name?: string;
  timeout?: number;
}

export interface GeminiSettings extends Record<string, unknown> {
  hooks?: {
    SessionStart?: GeminiHookEntry[];
  };
}

/**
 * The Gemini-family script directory: alongside the settings file it serves.
 *
 * Antigravity has no project-scoped hook surface (it is global-only), so in
 * the scope where the two adapters overlap they resolve to the same
 * `~/.gemini/bluud/` directory and one script covers both — the same
 * "writing it once covers both" property the shared settings entry has.
 */
export function geminiHookScriptSpec(env: AdapterEnv): HookScriptSpec {
  return { dir: join(geminiConfigDir(env), BLUUD_DIR_NAME), format: "gemini" };
}

export function geminiHookScriptPath(env: AdapterEnv): string {
  return join(
    geminiConfigDir(env),
    BLUUD_DIR_NAME,
    hookScriptFileName(process.platform !== "win32"),
  );
}

function geminiConfigDir(env: AdapterEnv): string {
  return env.global ? join(env.home, ".gemini") : join(env.cwd, ".gemini");
}

/**
 * Null when the script path cannot be safely embedded in a shell command; the
 * caller then leaves this tool unconfigured rather than writing a hook that
 * would fail at session start.
 */
export function buildGeminiHookCommand(scriptPath: string): string | null {
  return hookScriptCommandOrNull(scriptPath);
}

export async function hasGeminiHook(settingsPath: string, scriptPath: string): Promise<boolean> {
  const command = buildGeminiHookCommand(scriptPath);
  // An unquotable path has no writable command, so there is nothing pending —
  // report it as already satisfied so `plan` shows no phantom change.
  if (command === null) return true;
  const text = await readTextFile(settingsPath);
  if (text === null) return false;
  return text.includes(command);
}

/** Returns false when the path was unquotable and no hook was written. */
export async function applyGeminiSessionStartHook(
  settingsPath: string,
  scriptPath: string,
  hookName: string,
): Promise<boolean> {
  const command = buildGeminiHookCommand(scriptPath);
  if (command === null) return false;

  await mergeJsonFile<GeminiSettings>(settingsPath, (current) => {
    const next = { ...current };
    next.hooks = { ...next.hooks };
    const existingEntries = next.hooks.SessionStart ?? [];
    const alreadyPresent = existingEntries.some(
      (entry) => entry.type === "command" && entry.command === command,
    );
    next.hooks.SessionStart = alreadyPresent
      ? existingEntries
      : [...existingEntries, { type: "command", command, name: hookName, timeout: 15000 }];
    return next;
  });

  return true;
}

export async function removeGeminiSessionStartHook(
  settingsPath: string,
  scriptPath: string,
): Promise<boolean> {
  const existing = await readTextFile(settingsPath);
  if (existing === null) return false;

  const command = buildGeminiHookCommand(scriptPath);
  if (command === null) return false;

  let changed = false;
  await mergeJsonFile<GeminiSettings>(settingsPath, (current) => {
    if (!current.hooks?.SessionStart) return current;
    const next = { ...current };
    next.hooks = { ...next.hooks };
    const before = next.hooks.SessionStart ?? [];
    const after = before.filter((h) => !(h.type === "command" && h.command === command));
    next.hooks.SessionStart = after;
    changed = after.length !== before.length;
    return next;
  });

  return changed;
}
