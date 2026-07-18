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
 *   command = '<bluud binary> pull --inject'
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
    const command = buildHookCommand(env.bluudBinary);
    const wouldChange = detected && !(await tomlFileContains(configPath, command));

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
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

    const configPath = getConfigPath(env);
    const command = buildHookCommand(env.bluudBinary);
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

function buildHookCommand(bluudBinary: string): string {
  return `${bluudBinary} pull --inject`;
}

export async function uninstallCodex(env: AdapterEnv): Promise<boolean> {
  const configPath = getConfigPath(env);
  if (!existsSync(configPath)) return false;
  return removeTomlMarkerBlockFile(configPath, MARKER_SCOPE);
}
