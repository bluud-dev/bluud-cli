/**
 * Gemini CLI hook adapter.
 *
 * Writes a `SessionStart` hook into `~/.gemini/settings.json` (global) or
 * `<repo>/.gemini/settings.json` (project) so Gemini CLI runs
 * `bluud pull --inject --format=gemini` at session start.
 *
 * See `geminiHooks.ts` for the hook schema and the shared merge logic this
 * adapter shares with the Antigravity adapter (both read/write the identical
 * `~/.gemini/settings.json`).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import { readTextFile } from "./writer.js";
import {
  applyGeminiSessionStartHook,
  geminiHookScriptPath,
  geminiHookScriptSpec,
  hasGeminiHook,
  removeGeminiSessionStartHook,
} from "./geminiHooks.js";
import { applyHookScript, planHookScript, removeHookScript } from "./hookScript.js";

const ADAPTER_NAME = "gemini-cli";

export const geminiCliAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    return existsSync(getConfigDir(env));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const settingsPath = getSettingsPath(env);
    const detected = await this.detect(env);
    const existing = await readTextFile(settingsPath);
    const script = await planHookScript(env, geminiHookScriptSpec(env));
    const wouldChange = detected && !(await hasGeminiHook(settingsPath, script.path));

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: script.path,
          description: script.foreign
            ? "Bluud pull hook script (skipped — an existing user-authored script is present)"
            : "Bluud pull hook script (shared with Antigravity)",
          present: script.present,
          wouldChange: detected && script.wouldChange,
        },
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

    const scriptPath = await applyHookScript(env, geminiHookScriptSpec(env));
    if (scriptPath === null) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const wrote = await applyGeminiSessionStartHook(
      getSettingsPath(env),
      scriptPath,
      "bluud-memory-pull",
    );

    return { name: ADAPTER_NAME, applied: wrote, actions: plan.actions };
  },
};

function getConfigDir(env: AdapterEnv): string {
  return env.global ? join(env.home, ".gemini") : join(env.cwd, ".gemini");
}

function getSettingsPath(env: AdapterEnv): string {
  return join(getConfigDir(env), "settings.json");
}

/**
 * Gemini CLI and Antigravity share one settings entry and one script, so
 * uninstalling either removes the integration for both — the same coupling the
 * shared install has always had, made explicit here rather than silently
 * leaving a hook pointing at a deleted script.
 */
export async function uninstallGeminiCli(env: AdapterEnv): Promise<boolean> {
  const scriptPath = geminiHookScriptPath(env);
  const removedHook = await removeGeminiSessionStartHook(getSettingsPath(env), scriptPath);
  const removedScript = await removeHookScript(scriptPath);
  return removedHook || removedScript;
}
