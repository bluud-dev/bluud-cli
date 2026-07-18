/**
 * Kimi Code CLI hook adapter.
 *
 * Writes a `SessionStart` hook into `~/.kimi-code/config.toml`.
 *
 * Schema (verified against
 * https://moonshotai.github.io/kimi-code/en/customization/hooks):
 *
 *   [[hooks]]
 *   event = "SessionStart"
 *   matcher = "startup"
 *   command = '<bluud binary> pull'
 *   timeout = 30
 *
 * Kimi Code CLI's hook array is flat (one `[[hooks]]` table per hook, keyed by
 * an `event` field) rather than grouped per event name like Claude Code/Codex.
 * `matcher` only accepts "startup" | "resume" (no "clear"/"compact").
 *
 * IMPORTANT LIMITATION (verified against the same doc): Kimi Code CLI's
 * `SessionStart` is explicitly documented as *observation-only* — it fires
 * and forgets, and cannot inject stdout/JSON into the model's context, unlike
 * Claude Code, Codex CLI, or Gemini CLI. The command therefore runs plain
 * `bluud pull` (no `--inject`) purely to warm the local project-token/memory
 * cache; it does not deliver memory into the conversation. Actual injection on
 * Kimi is driven by the bundled `SKILL.md` instructing the agent to run
 * `bluud pull` itself, exactly as on the ~70 non-hook tools. `bluud doctor`
 * and the plan description surface this limitation explicitly so it is never
 * silently assumed to behave like the other adapters.
 *
 * Only the user-level config (`~/.kimi-code/config.toml`) is documented for
 * hooks, so this adapter is a no-op in project (`--global` absent) scope.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import {
  tomlFileContains,
  tomlString,
  writeTomlMarkerBlockFile,
  removeTomlMarkerBlockFile,
} from "./toml.js";

const ADAPTER_NAME = "kimi-code-cli";
const MARKER_SCOPE = "session-start";

export const kimiAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    if (!env.global) return false; // Hooks are documented as user-level only.
    return existsSync(join(env.home, ".kimi-code"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const detected = await this.detect(env);
    const configPath = getConfigPath(env);
    const command = buildHookCommand(env.bluudBinary);
    const wouldChange = detected && !(await tomlFileContains(configPath, command));

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: configPath,
          description:
            "SessionStart hook in ~/.kimi-code/config.toml (observation-only — cannot inject context; memory pull is driven by the bundled skill instead)",
          present: existsSync(configPath),
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

    const configPath = getConfigPath(env);
    const command = buildHookCommand(env.bluudBinary);
    const alreadyPresent = await tomlFileContains(configPath, command);

    if (!alreadyPresent) {
      const block = [
        "[[hooks]]",
        'event = "SessionStart"',
        'matcher = "startup"',
        `command = ${tomlString(command)}`,
        "timeout = 30",
      ].join("\n");
      await writeTomlMarkerBlockFile(configPath, MARKER_SCOPE, block);
    }

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getConfigPath(env: AdapterEnv): string {
  return join(env.home, ".kimi-code", "config.toml");
}

function buildHookCommand(bluudBinary: string): string {
  return `${bluudBinary} pull`;
}

export async function uninstallKimi(env: AdapterEnv): Promise<boolean> {
  const configPath = getConfigPath(env);
  if (!existsSync(configPath)) return false;
  return removeTomlMarkerBlockFile(configPath, MARKER_SCOPE);
}
