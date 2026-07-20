/**
 * Codex CLI hook adapter.
 *
 * Writes a `SessionStart` hook into `~/.codex/config.toml` (global) or
 * `<repo>/.codex/config.toml` (project) so Codex runs `bluud pull --inject`
 * at the start of a session and folds its stdout into `additionalContext`.
 *
 * Schema (verified against https://developers.openai.com/codex/hooks and
 * https://developers.openai.com/codex/config-reference):
 *
 *   [[hooks.SessionStart]]
 *   matcher = "startup|resume"
 *
 *   [[hooks.SessionStart.hooks]]
 *   type = "command"
 *   command = '<.codex/bluud/bluud-pull-hook.sh>'
 *
 * `matcher` filters on the hook's `source` field ("startup" | "resume" |
 * "clear" | "compact"); Codex's own docs use a `|`-delimited alternation
 * string rather than an array, which is mirrored here. Plain stdout text is
 * added as `additionalContext`, same as Claude Code.
 *
 * Project-scoped hooks additionally require the repo's `.codex/` layer to be
 * marked "trusted" inside Codex CLI itself — Bluud cannot set that flag (it
 * lives in Codex's own trust store), so the plan/apply description calls it
 * out rather than silently assuming it will fire.
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
  hookScriptCommandOrNull,
  hookScriptFileName,
  planHookScript,
  removeHookScript,
  type HookScriptSpec,
} from "./hookScript.js";

const ADAPTER_NAME = "codex";
const MARKER_SCOPE = "session-start";

export const codexAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    return existsSync(getConfigDir(env));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const configPath = getConfigPath(env);
    const detected = await this.detect(env);
    const script = await planHookScript(env, hookScriptSpec(env));
    const command = buildHookCommand(script.path);
    // A path with no writable command has nothing pending — never report a
    // change `apply` would refuse to make.
    const wouldChange =
      detected && command !== null && !(await tomlFileContains(configPath, command));

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
          description: env.global
            ? "SessionStart hook in ~/.codex/config.toml"
            : "SessionStart hook in .codex/config.toml (requires Codex to trust this repo's .codex/ layer)",
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
    if (command === null) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }
    const alreadyPresent = await tomlFileContains(configPath, command);

    if (!alreadyPresent) {
      const block = [
        "[[hooks.SessionStart]]",
        'matcher = "startup|resume"',
        "",
        "[[hooks.SessionStart.hooks]]",
        'type = "command"',
        `command = ${tomlString(command)}`,
      ].join("\n");
      await writeTomlMarkerBlockFile(configPath, MARKER_SCOPE, block);
    }

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getConfigDir(env: AdapterEnv): string {
  return env.global ? join(env.home, ".codex") : join(env.cwd, ".codex");
}

function getConfigPath(env: AdapterEnv): string {
  return join(getConfigDir(env), "config.toml");
}

/** Codex folds plain stdout into `additionalContext`, so no `--format`. */
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

export async function uninstallCodex(env: AdapterEnv): Promise<boolean> {
  const removedScript = await removeHookScript(getScriptPath(env));
  const configPath = getConfigPath(env);
  if (!existsSync(configPath)) return removedScript;
  const removedBlock = await removeTomlMarkerBlockFile(configPath, MARKER_SCOPE);
  return removedBlock || removedScript;
}
