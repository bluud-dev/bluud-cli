/**
 * Claude Code hook adapter.
 *
 * Writes a `SessionStart` hook into Claude Code's settings file so that every
 * new conversation runs `bluud pull --inject` and loads project memory into the
 * context.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import {
  mergeJsonFile,
  writeMarkerBlockFile,
  removeMarkerBlockFile,
  readTextFile,
} from "./writer.js";

const ADAPTER_NAME = "claude-code";
const MARKER_SCOPE = "session-start";

export const claudeCodeAdapter: Adapter = {
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

    // Write the SessionStart hook via JSON merge so unrelated settings are preserved.
    await mergeJsonFile<ClaudeSettings>(settingsPath, (current) => {
      const next = { ...current };
      if (!next.hooks) next.hooks = {};
      if (!next.hooks.SessionStart) next.hooks.SessionStart = [];
      const hook = buildHookCommand(env.bluudBinary);
      if (!next.hooks.SessionStart.includes(hook)) {
        next.hooks.SessionStart = [...next.hooks.SessionStart, hook];
      }
      return next;
    });

    // Also write a marker-guarded instruction block for human-readable context.
    await writeMarkerBlockFile(join(getConfigDir(env), "CLAUDE.md"), {
      startMarker: "<!-- bluud:memory:start -->",
      endMarker: "<!-- bluud:memory:end -->",
      content: `This Claude Code installation is managed by Bluud.\nProject memory is injected automatically via a SessionStart hook.`,
    });

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

function buildHookCommand(bluudBinary: string): string {
  return `${bluudBinary} pull --inject`;
}

function hasHook(text: string | null, bluudBinary: string): boolean {
  if (text === null) return false;
  return text.includes(buildHookCommand(bluudBinary));
}

interface ClaudeSettings extends Record<string, unknown> {
  hooks?: {
    SessionStart?: string[];
  };
}

export async function uninstallClaudeCode(env: AdapterEnv): Promise<boolean> {
  const settingsPath = getSettingsPath(env);
  const removedMarker = await removeMarkerBlockFile(
    join(getConfigDir(env), "CLAUDE.md"),
    MARKER_SCOPE,
  );

  const existing = await readTextFile(settingsPath);
  if (existing === null) return removedMarker;

  let changed = false;
  await mergeJsonFile<ClaudeSettings>(settingsPath, (current) => {
    if (!current.hooks?.SessionStart) return current;
    const hook = buildHookCommand(env.bluudBinary);
    const next = { ...current };
    next.hooks = { ...next.hooks };
    const currentHooks = next.hooks.SessionStart ?? [];
    next.hooks.SessionStart = currentHooks.filter((h) => h !== hook);
    changed = next.hooks.SessionStart.length !== (current.hooks.SessionStart?.length ?? 0);
    return next;
  });

  return changed || removedMarker;
}
