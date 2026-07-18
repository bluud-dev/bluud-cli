/**
 * Cline hook adapter.
 *
 * Writes a `TaskStart` hook script (Cline's closest analog to "SessionStart")
 * so Cline runs `bluud pull --inject --format=cline` at the start of a task.
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
 */

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import { atomicWriteFile, readTextFile } from "./writer.js";

const ADAPTER_NAME = "cline";
const HOOK_FILE_NAME = "TaskStart";
const MANAGED_MARKER = "# bluud:managed";

/**
 * True when `content` contains the managed marker as one of its own lines.
 *
 * The marker cannot be the first line of the file (the shebang must occupy
 * line 1 for the OS to invoke the right interpreter), so this checks for an
 * exact line match rather than `startsWith`.
 */
function isManagedByBluud(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === MANAGED_MARKER);
}

export const clineAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    if (process.platform === "win32") return false; // Cline hooks are unix-only.
    return existsSync(join(env.home, ".cline"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const detected = await this.detect(env);
    const hookPath = getHookPath(env);
    const existing = await readTextFile(hookPath);
    const foreignHook = existing !== null && !isManagedByBluud(existing);
    const command = buildHookCommand(env.bluudBinary);
    const wouldChange =
      detected && !foreignHook && (existing === null || !existing.includes(command));

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: hookPath,
          description: foreignHook
            ? "TaskStart hook (skipped — an existing user-authored hook is present)"
            : "TaskStart hook (Cline runs this on the next turn, not the first — see contextModification limitation)",
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

    const hookPath = getHookPath(env);
    const existing = await readTextFile(hookPath);
    const foreignHook = existing !== null && !isManagedByBluud(existing);
    if (foreignHook) {
      // Never overwrite a hook we did not write.
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const command = buildHookCommand(env.bluudBinary);
    if (existing === null || !existing.includes(command)) {
      const script = [
        "#!/usr/bin/env sh",
        MANAGED_MARKER,
        "# Managed by Bluud. Re-running `bluud` regenerates this file; a hand",
        "# edit without the marker above is left untouched on the next run.",
        "# Cline's TaskStart payload on stdin is not needed by `bluud pull`, so",
        "# it is intentionally left unconsumed.",
        `exec ${command}`,
      ].join("\n");
      await atomicWriteFile(hookPath, `${script}\n`);
      await chmod(hookPath, 0o755);
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

function buildHookCommand(bluudBinary: string): string {
  return `${bluudBinary} pull --inject --format=cline`;
}

export async function uninstallCline(env: AdapterEnv): Promise<boolean> {
  const hookPath = getHookPath(env);
  const existing = await readTextFile(hookPath);
  if (existing === null || !isManagedByBluud(existing)) return false;

  const { rm } = await import("node:fs/promises");
  await rm(hookPath, { force: true });
  return true;
}
