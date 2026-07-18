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
  hasGeminiHook,
  removeGeminiSessionStartHook,
} from "./geminiHooks.js";

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
    const wouldChange = detected && !(await hasGeminiHook(settingsPath, env.bluudBinary));

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
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

    await applyGeminiSessionStartHook(getSettingsPath(env), env.bluudBinary, "bluud-memory-pull");

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getSettingsPath(env: AdapterEnv): string {
  return join(env.home, ".gemini", "settings.json");
}

export async function uninstallAntigravity(env: AdapterEnv): Promise<boolean> {
  return removeGeminiSessionStartHook(getSettingsPath(env), env.bluudBinary);
}
