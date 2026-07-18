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
 * `bluud pull --inject --format=gemini` emits the
 * `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`
 * envelope instead of plain text (see `renderGeminiHookOutput` in
 * `lib/memory.ts`) to satisfy that contract.
 */

import { mergeJsonFile, readTextFile } from "./writer.js";

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

export function buildGeminiHookCommand(bluudBinary: string): string {
  return `${bluudBinary} pull --inject --format=gemini`;
}

export async function hasGeminiHook(settingsPath: string, bluudBinary: string): Promise<boolean> {
  const text = await readTextFile(settingsPath);
  if (text === null) return false;
  return text.includes(buildGeminiHookCommand(bluudBinary));
}

export async function applyGeminiSessionStartHook(
  settingsPath: string,
  bluudBinary: string,
  hookName: string,
): Promise<void> {
  await mergeJsonFile<GeminiSettings>(settingsPath, (current) => {
    const next = { ...current };
    next.hooks = { ...next.hooks };
    const existingEntries = next.hooks.SessionStart ?? [];
    const command = buildGeminiHookCommand(bluudBinary);
    const alreadyPresent = existingEntries.some(
      (entry) => entry.type === "command" && entry.command === command,
    );
    next.hooks.SessionStart = alreadyPresent
      ? existingEntries
      : [...existingEntries, { type: "command", command, name: hookName, timeout: 15000 }];
    return next;
  });
}

export async function removeGeminiSessionStartHook(
  settingsPath: string,
  bluudBinary: string,
): Promise<boolean> {
  const existing = await readTextFile(settingsPath);
  if (existing === null) return false;

  let changed = false;
  await mergeJsonFile<GeminiSettings>(settingsPath, (current) => {
    if (!current.hooks?.SessionStart) return current;
    const command = buildGeminiHookCommand(bluudBinary);
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
