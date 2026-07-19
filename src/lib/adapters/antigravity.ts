/**
 * Antigravity hook adapter.
 *
 * Antigravity (Google's agentic IDE, built on the Gemini stack) reads Gemini
 * CLI's own `~/.gemini/settings.json` for lifecycle hooks — there is no
 * separate Antigravity hooks file. Verified against gortex's
 * `internal/agents/antigravity/adapter.go`, which merges into the identical
 * file/shape as its own Gemini CLI adapter and notes the two "never
 * double-register" because they check for the same command string. This
 * adapter reuses that shared logic from `geminiHooks.ts` rather than
 * duplicating it.
 *
 * Antigravity has no separate config home of its own beyond
 * `~/.gemini/antigravity/`, and — like gortex's adapter — this is user-level
 * only; there is no documented project-scoped hook surface for it.
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

const ADAPTER_NAME = "antigravity";

export const antigravityAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    if (!env.global) return false; // No documented project-scoped hook surface.
    return existsSync(join(env.home, ".gemini", "antigravity"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const detected = await this.detect(env);
    const settingsPath = getSettingsPath(env);
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
            : "Bluud pull hook script (shared with Gemini CLI)",
          present: script.present,
          wouldChange: detected && script.wouldChange,
        },
        {
          path: settingsPath,
          description:
            "SessionStart hook in ~/.gemini/settings.json (shared with Gemini CLI — writing it once covers both)",
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

    await applyGeminiSessionStartHook(getSettingsPath(env), scriptPath, "bluud-memory-pull");

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getSettingsPath(env: AdapterEnv): string {
  return join(env.home, ".gemini", "settings.json");
}

/** Shared with Gemini CLI — see `uninstallGeminiCli` for the coupling note. */
export async function uninstallAntigravity(env: AdapterEnv): Promise<boolean> {
  const scriptPath = geminiHookScriptPath(env);
  const removedHook = await removeGeminiSessionStartHook(getSettingsPath(env), scriptPath);
  const removedScript = await removeHookScript(scriptPath);
  return removedHook || removedScript;
}
