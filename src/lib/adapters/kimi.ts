/**
 * Kimi Code CLI hook adapter.
 *
 * Writes a `UserPromptSubmit` hook into `~/.kimi-code/config.toml`.
 *
 * Schema (verified against
 * https://moonshotai.github.io/kimi-code/en/customization/hooks and
 * https://moonshotai.github.io/kimi-code/en/configuration/config-files):
 *
 *   [[hooks]]
 *   event = "UserPromptSubmit"
 *   command = '<bluud binary> pull --inject'
 *   timeout = 30
 *
 * Kimi Code CLI's hook array is flat (one `[[hooks]]` table per hook, keyed
 * by an `event` field) rather than grouped per event name like Claude
 * Code/Codex.
 *
 * IMPORTANT, VERIFIED CORRECTION: an earlier version of this adapter used
 * `SessionStart`, which Kimi Code CLI documents as *observation-only* — it
 * cannot inject stdout into the model's context. gortex's own real-world
 * Kimi adapter (`internal/agents/kimi/adapter.go`) confirms this and instead
 * wires its context-injection hook onto `UserPromptSubmit` ("pre-turn context
 * injection"), which Kimi's docs confirm supports it: a `UserPromptSubmit`
 * hook's plain stdout text "is appended to context" (unlike SessionStart,
 * which is fire-and-forget). This adapter does the same, so memory actually
 * reaches the model here rather than being silently dropped.
 *
 * The tradeoff: `UserPromptSubmit` fires on every user turn, not once per
 * session, so `bluud pull --inject` runs (and its output is re-injected)
 * every turn rather than only at session start. This is the only mechanism
 * Kimi documents for automatic context injection, so it is the correct
 * choice despite firing more often than the other adapters' SessionStart
 * hooks.
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
import {
  BLUUD_DIR_NAME,
  applyHookScript,
  hookScriptCommand,
  hookScriptFileName,
  planHookScript,
  removeHookScript,
  type HookScriptSpec,
} from "./hookScript.js";

const ADAPTER_NAME = "kimi-code-cli";
const MARKER_SCOPE = "user-prompt-submit";

export const kimiAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    if (!env.global) return false; // Hooks are documented as user-level only.
    return existsSync(join(env.home, ".kimi-code"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const detected = await this.detect(env);
    const configPath = getConfigPath(env);
    const script = await planHookScript(env, hookScriptSpec(env));
    const command = buildHookCommand(script.path);
    const wouldChange = detected && !(await tomlFileContains(configPath, command));

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
          path: configPath,
          description:
            "UserPromptSubmit hook in ~/.kimi-code/config.toml (Kimi's SessionStart cannot inject context, so memory is re-injected on every turn instead)",
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

    const scriptPath = await applyHookScript(env, hookScriptSpec(env));
    if (scriptPath === null) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const configPath = getConfigPath(env);
    const command = buildHookCommand(scriptPath);
    const alreadyPresent = await tomlFileContains(configPath, command);

    if (!alreadyPresent) {
      const block = [
        "[[hooks]]",
        'event = "UserPromptSubmit"',
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

/** Kimi appends a UserPromptSubmit hook's plain stdout, so no `--format`. */
function hookScriptSpec(env: AdapterEnv): HookScriptSpec {
  return { dir: join(env.home, ".kimi-code", BLUUD_DIR_NAME) };
}

function getScriptPath(env: AdapterEnv): string {
  return join(
    env.home,
    ".kimi-code",
    BLUUD_DIR_NAME,
    hookScriptFileName(process.platform !== "win32"),
  );
}

function buildHookCommand(scriptPath: string): string {
  return hookScriptCommand(scriptPath);
}

export async function uninstallKimi(env: AdapterEnv): Promise<boolean> {
  const removedScript = await removeHookScript(getScriptPath(env));
  const configPath = getConfigPath(env);
  if (!existsSync(configPath)) return removedScript;
  const removedBlock = await removeTomlMarkerBlockFile(configPath, MARKER_SCOPE);
  return removedBlock || removedScript;
}
