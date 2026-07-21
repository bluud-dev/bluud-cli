/**
 * Cline hook adapter.
 *
 * Writes a `TaskStart` hook script (Cline's closest analog to "SessionStart")
 * so Cline runs `bluud pull --inject --index --format=cline` at the start of
 * a task — the lightweight index wrapped in Cline's hook envelope, never the
 * full tree.
 *
 * Schema (verified against https://docs.cline.bot/features/hooks and
 * https://cline.ghost.io/cline-v3-36-hooks/):
 *
 *   - One executable file per hook type, named exactly after the hook
 *     ("TaskStart", no extension), at:
 *       global: ~/Documents/Cline/Rules/Hooks/TaskStart
 *       project: <repo>/.clinerules/hooks/TaskStart
 *   - The hook reads a JSON object on stdin and must print a JSON object on
 *     stdout of the shape `{"contextModification": "..."}` to influence the
 *     conversation.
 *   - Cline hooks are documented as macOS/Linux only (no Windows support as
 *     of v3.36), so `detect()` returns false on win32 regardless of whether
 *     Cline itself is installed.
 *
 * IMPORTANT LIMITATION (verified against the same docs): `contextModification`
 * is folded into the *next* API request, not the current turn — so memory
 * lands from the task's second exchange onward, not the very first message.
 *
 * Because a hook is a single dedicated file (not a mergeable config), Bluud
 * marks its own hook with a `# bluud:managed` comment line (line 2 — the
 * shebang must stay on line 1 for the OS to invoke the right interpreter). If
 * the file already exists without that marker, it is treated as a
 * user-authored hook and left untouched rather than clobbered — this is the
 * file-level analog of "merge preserving user keys" for a format with no
 * merge points.
 *
 * Cline is the one adapter whose hook *is* the script, so it writes the shared
 * `bluud-pull-hook.sh` artifact under the name Cline requires (`TaskStart`).
 * Everything else about the file — the marker, the fail-open contract, the
 * unread stdin payload — comes from that one authored template rather than
 * from a string built here.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import {
  applyHookScript,
  planHookScript,
  removeHookScript,
  type HookScriptSpec,
} from "./hookScript.js";

const ADAPTER_NAME = "cline";
const HOOK_FILE_NAME = "TaskStart";

export const clineAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    if (process.platform === "win32") return false; // Cline hooks are unix-only.
    return existsSync(join(env.home, ".cline"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const detected = await this.detect(env);
    const script = await planHookScript(env, hookScriptSpec(env));

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: script.path,
          description: script.foreign
            ? "TaskStart hook (skipped — an existing user-authored hook is present)"
            : "TaskStart hook (Cline runs this on the next turn, not the first — see contextModification limitation)",
          present: script.present,
          wouldChange: detected && script.wouldChange,
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

    // Never overwrite a hook we did not write.
    const scriptPath = await applyHookScript(env, hookScriptSpec(env));
    if (scriptPath === null) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

function getHooksDir(env: AdapterEnv): string {
  return env.global
    ? join(env.home, "Documents", "Cline", "Rules", "Hooks")
    : join(env.cwd, ".clinerules", "hooks");
}

function getHookPath(env: AdapterEnv): string {
  return join(getHooksDir(env), HOOK_FILE_NAME);
}

/**
 * Cline dictates both the file name (`TaskStart`, no extension) and the wire
 * format (`{"contextModification": "..."}`), and documents hooks as unix-only —
 * hence the forced POSIX template.
 */
function hookScriptSpec(env: AdapterEnv): HookScriptSpec {
  return {
    dir: getHooksDir(env),
    fileName: HOOK_FILE_NAME,
    format: "cline",
    posix: true,
  };
}

export async function uninstallCline(env: AdapterEnv): Promise<boolean> {
  return removeHookScript(getHookPath(env));
}
