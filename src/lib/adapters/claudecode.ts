/**
 * Claude Code hook adapter.
 *
 * Writes a `SessionStart` hook into Claude Code's settings file so that every
 * new conversation runs `bluud pull --inject` and loads project memory into
 * the context.
 *
 * Schema (verified against https://code.claude.com/docs/en/hooks):
 *   hooks.SessionStart: Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string }> }>
 * `matcher` is one of "startup" | "resume" | "clear" | "compact"; omitting it
 * (or using "*") matches every SessionStart source. Bluud omits it so memory
 * is refreshed on every source, not just a fresh `claude` launch. Plain stdout
 * text from the command is automatically added as context for this event.
 *
 * The stored command invokes the materialized hook script in `.claude/bluud/`
 * rather than `bluud` directly — see `hookScript.ts` for why (stable path plus
 * the section 9.1 fail-open contract).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import {
  mergeJsonFile,
  writeMarkerBlockFile,
  removeMarkerBlockFile,
  readTextFile,
  markerBlock,
} from "./writer.js";
import {
  BLUUD_DIR_NAME,
  applyHookScript,
  hookScriptCommandOrNull,
  hookScriptFileName,
  planHookScript,
  removeHookScript,
  type HookScriptSpec,
} from "./hookScript.js";

const ADAPTER_NAME = "claude-code";
// Scope for the CLAUDE.md instruction block (see `markerBlock`), producing
// `<!-- bluud:memory:start -->` / `<!-- bluud:memory:end -->`. Both the write
// and remove side must derive markers from this same scope — a previous
// version hardcoded the write-side markers as literal strings while the
// remove side built them from a *different* scope string ("session-start"),
// so `uninstallClaudeCode` never matched and silently left the block behind.
const MARKER_SCOPE = "memory";

interface ClaudeHookEntry {
  type: "command";
  command: string;
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings extends Record<string, unknown> {
  hooks?: {
    SessionStart?: ClaudeHookMatcher[];
  };
}

export const claudeCodeAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    return existsSync(getConfigDir(env));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const settingsPath = getSettingsPath(env);
    const detected = await this.detect(env);
    const existing = await readTextFile(settingsPath);
    const script = await planHookScript(env, hookScriptSpec(env));
    const wouldChange = detected && !hasHook(existing, script.path);

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: script.path,
          description: script.foreign
            ? "Bluud pull hook script (skipped — an existing user-authored script is present)"
            : "Bluud pull hook script",
          present: script.present,
          wouldChange: detected && script.wouldChange,
        },
        {
          path: settingsPath,
          description: "SessionStart hook in Claude Code settings",
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

    const settingsPath = getSettingsPath(env);

    if (opts.dryRun) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const scriptPath = await applyHookScript(env, hookScriptSpec(env));
    if (scriptPath === null) {
      // A user-authored script occupies the path; wiring settings.json to it
      // would hand the session to a file Bluud does not control.
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const command = buildHookCommand(scriptPath);
    if (command === null) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    // Write the SessionStart hook via JSON merge so unrelated settings are preserved.
    await mergeJsonFile<ClaudeSettings>(settingsPath, (current) => {
      const next = { ...current };
      next.hooks = { ...next.hooks };
      const existingEntries = next.hooks.SessionStart ?? [];
      const alreadyPresent = existingEntries.some((entry) =>
        entry.hooks.some((h) => h.type === "command" && h.command === command),
      );
      if (!alreadyPresent) {
        next.hooks.SessionStart = [...existingEntries, { hooks: [{ type: "command", command }] }];
      } else {
        next.hooks.SessionStart = existingEntries;
      }
      return next;
    });

    // Also write a marker-guarded instruction block for human-readable context.
    await writeMarkerBlockFile(
      join(getConfigDir(env), "CLAUDE.md"),
      markerBlock(
        MARKER_SCOPE,
        `This Claude Code installation is managed by Bluud.\nProject memory is injected automatically via a SessionStart hook.`,
      ),
    );

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getConfigDir(env: AdapterEnv): string {
  return env.global ? join(env.home, ".claude") : join(env.cwd, ".claude");
}

function getSettingsPath(env: AdapterEnv): string {
  return env.global
    ? join(env.home, ".claude", "settings.json")
    : join(env.cwd, ".claude", "settings.local.json");
}

/** Claude Code consumes plain stdout as context, so no `--format` is needed. */
function hookScriptSpec(env: AdapterEnv): HookScriptSpec {
  return { dir: join(getConfigDir(env), BLUUD_DIR_NAME) };
}

function getScriptPath(env: AdapterEnv): string {
  return join(getConfigDir(env), BLUUD_DIR_NAME, hookScriptFileName(process.platform !== "win32"));
}

/**
 * Null when the script path cannot be safely embedded in a shell command; the
 * caller then leaves this tool unconfigured rather than writing a hook that
 * would fail at session start.
 */
function buildHookCommand(scriptPath: string): string | null {
  return hookScriptCommandOrNull(scriptPath);
}

function hasHook(text: string | null, scriptPath: string): boolean {
  const command = buildHookCommand(scriptPath);
  // An unquotable path has no writable command, so there is nothing pending —
  // report it as already satisfied so `plan` shows no phantom change.
  if (command === null) return true;
  if (text === null) return false;
  return text.includes(command);
}

export async function uninstallClaudeCode(env: AdapterEnv): Promise<boolean> {
  const settingsPath = getSettingsPath(env);
  const removedMarker = await removeMarkerBlockFile(
    join(getConfigDir(env), "CLAUDE.md"),
    MARKER_SCOPE,
  );
  const scriptPath = getScriptPath(env);
  const removedScript = await removeHookScript(scriptPath);

  const existing = await readTextFile(settingsPath);
  if (existing === null) return removedMarker || removedScript;

  const command = buildHookCommand(scriptPath);
  if (command === null) return removedMarker || removedScript;

  let changed = false;
  await mergeJsonFile<ClaudeSettings>(settingsPath, (current) => {
    if (!current.hooks?.SessionStart) return current;
    const next = { ...current };
    next.hooks = { ...next.hooks };
    const before = next.hooks.SessionStart ?? [];
    const after = before
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((h) => !(h.type === "command" && h.command === command)),
      }))
      .filter((entry) => entry.hooks.length > 0);
    next.hooks.SessionStart = after;
    const beforeCount = before.reduce((n, e) => n + e.hooks.length, 0);
    const afterCount = after.reduce((n, e) => n + e.hooks.length, 0);
    changed = afterCount !== beforeCount;
    return next;
  });

  return changed || removedMarker || removedScript;
}
