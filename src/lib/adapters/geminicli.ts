/**
 * Gemini CLI hook adapter.
 *
 * Writes a `SessionStart` hook into `~/.gemini/settings.json` (global) or
 * `<repo>/.gemini/settings.json` (project) so Gemini CLI runs
 * `bluud pull --inject --format=gemini` at session start.
 *
 * Schema (verified against
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md):
 *
 *   { "hooks": { "SessionStart": [ { "type": "command", "command": "...", "name"?: "...", "timeout"?: number } ] } }
 *
 * Unlike Claude Code / Codex, Gemini CLI's SessionStart entries are flat
 * objects (no `matcher`/nested `hooks` wrapper), and — critically — the hook
 * process must print *only* a single JSON object to stdout; any stray plain
 * text breaks Gemini's parser. `bluud pull --inject --format=gemini` emits
 * `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`
 * to satisfy that contract (see `renderGeminiHookOutput` in `lib/memory.ts`).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import { mergeJsonFile, readTextFile } from "./writer.js";

const ADAPTER_NAME = "gemini-cli";

interface GeminiHookEntry {
  type: "command";
  command: string;
  name?: string;
  timeout?: number;
}

interface GeminiSettings extends Record<string, unknown> {
  hooks?: {
    SessionStart?: GeminiHookEntry[];
  };
}

export const geminiCliAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    return existsSync(getConfigDir(env));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const settingsPath = getSettingsPath(env);
    const detected = await this.detect(env);
    const existing = await readTextFile(settingsPath);
    const wouldChange = detected && !hasHook(existing, env.bluudBinary);

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: settingsPath,
          description: "SessionStart hook in Gemini CLI settings",
          present: existing !== null,
          wouldChange,
        },
      ],
    };
  },

  async apply(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult> {
    const plan = await this.plan(env);
    if (!plan.detected) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }
    if (opts.dryRun) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const settingsPath = getSettingsPath(env);
    await mergeJsonFile<GeminiSettings>(settingsPath, (current) => {
      const next = { ...current };
      next.hooks = { ...next.hooks };
      const existingEntries = next.hooks.SessionStart ?? [];
      const command = buildHookCommand(env.bluudBinary);
      const alreadyPresent = existingEntries.some(
        (entry) => entry.type === "command" && entry.command === command,
      );
      next.hooks.SessionStart = alreadyPresent
        ? existingEntries
        : [
            ...existingEntries,
            { type: "command", command, name: "bluud-memory-pull", timeout: 15000 },
          ];
      return next;
    });

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getConfigDir(env: AdapterEnv): string {
  return env.global ? join(env.home, ".gemini") : join(env.cwd, ".gemini");
}

function getSettingsPath(env: AdapterEnv): string {
  return join(getConfigDir(env), "settings.json");
}

function buildHookCommand(bluudBinary: string): string {
  return `${bluudBinary} pull --inject --format=gemini`;
}

function hasHook(text: string | null, bluudBinary: string): boolean {
  if (text === null) return false;
  return text.includes(buildHookCommand(bluudBinary));
}

export async function uninstallGeminiCli(env: AdapterEnv): Promise<boolean> {
  const settingsPath = getSettingsPath(env);
  const existing = await readTextFile(settingsPath);
  if (existing === null) return false;

  let changed = false;
  await mergeJsonFile<GeminiSettings>(settingsPath, (current) => {
    if (!current.hooks?.SessionStart) return current;
    const command = buildHookCommand(env.bluudBinary);
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
