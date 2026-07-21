/**
 * Hermes hook adapter (NousResearch hermes-agent).
 *
 * Hermes' hook model differs from every other tool Bluud wires, in three ways
 * that together decide this adapter's whole shape:
 *
 * 1. **Config is YAML, not JSON.** Hooks live under a `hooks:` mapping in
 *    `~/.hermes/config.yaml`, keyed by snake_case event name. Hermes configs
 *    are hand-written and commented, so this adapter merges through
 *    `yamlConfig.ts`'s document API rather than a parse/re-serialize round
 *    trip that would delete those comments.
 *
 * 2. **There is no usable session-start event.** Hermes exposes four hook
 *    events — `on_session_start`, `pre_tool_call`, `post_tool_call`, and
 *    `pre_llm_call` — but only two can affect a turn at all: `pre_tool_call`
 *    (which can block a tool call) and `pre_llm_call` (which can inject
 *    context). `on_session_start` is observer-only and `post_tool_call` is
 *    fire-and-forget; neither can contribute text to the conversation. So the
 *    obvious mapping — "session start hook, like Claude Code" — does not
 *    exist here, and memory has to ride `pre_llm_call`, the same event gortex
 *    uses for its own Hermes context injection
 *    (`internal/agents/hermes/hooks.go`).
 *
 * 3. **`pre_llm_call` fires every turn.** That is the price of (2), and it is
 *    handled in `pull.ts`: with `--format=hermes` the command reads Hermes'
 *    payload from stdin and no-ops on any turn but the first, so a per-turn
 *    event yields once-per-session injection and spends exactly one `pull`
 *    request per session. Without that gate this adapter would re-inject the
 *    entire memory index before every single LLM call.
 *
 * Scope: Hermes documents shell hooks only at global scope, and its hook
 * engine reads them only from `~/.hermes/config.yaml` — profiles may re-declare
 * `mcp_servers`, but not `hooks`. This adapter therefore writes the same
 * global config in both project and global install modes, and says so in its
 * plan rather than silently writing somewhere the user did not expect.
 *
 * Timeout: Hermes hook timeouts are in SECONDS (default 60, ceiling 300) —
 * unlike Claude Code's milliseconds. Bluud registers 30s: `bluud pull` makes
 * one HTTPS round trip, so the honest case is well under a second, but a
 * degraded network must not stall a turn for the full default minute. It only
 * ever costs this on the first turn, since later turns short-circuit before
 * any network call.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { isMap, isSeq, YAMLMap, type Document, type Node } from "yaml";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import { readTextFile } from "./writer.js";
import {
  ensureMap,
  ensureSeq,
  int,
  mergeYamlFile,
  quoted,
  removeFromSeq,
  scalarAt,
} from "./yamlConfig.js";
import {
  BLUUD_DIR_NAME,
  applyHookScript,
  hookScriptCommandOrNull,
  hookScriptFileName,
  planHookScript,
  removeHookScript,
  type HookScriptSpec,
} from "./hookScript.js";

const ADAPTER_NAME = "hermes-agent";

/**
 * The `hooks:` event key Bluud writes. See the module header for why this is
 * `pre_llm_call` and not `on_session_start`.
 */
const HERMES_INJECTION_EVENT = "pre_llm_call";

/**
 * Seconds, not milliseconds. See the module header.
 */
const HERMES_HOOK_TIMEOUT_SECONDS = 30;

export const hermesAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    return existsSync(hermesDir(env));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const configPath = getConfigPath(env);
    const detected = await this.detect(env);
    const existing = await readTextFile(configPath);
    const script = await planHookScript(env, hookScriptSpec(env));

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
          // Naming the event and the scope keeps `bluud doctor` honest about
          // the two things a Hermes user would otherwise be surprised by: the
          // hook is per-turn, and it is global even in a project install.
          description:
            "pre_llm_call hook in the global Hermes config (Hermes reads hooks only from ~/.hermes/config.yaml)",
          present: existing !== null,
          wouldChange: detected && !hasHook(existing, script.path),
        },
      ],
    };
  },

  async apply(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult> {
    const plan = await this.plan(env);
    if (!plan.detected || opts.dryRun) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const scriptPath = await applyHookScript(env, hookScriptSpec(env));
    if (scriptPath === null) {
      // A user-authored script occupies the path; pointing config.yaml at it
      // would hand the turn to a file Bluud does not control.
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const command = hookScriptCommandOrNull(scriptPath);
    if (command === null) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const written = await mergeYamlFile(getConfigPath(env), (doc) =>
      upsertHermesHook(doc, command, opts.force),
    );

    return { name: ADAPTER_NAME, applied: written, actions: plan.actions };
  },
};

/**
 * Ensure `hooks.pre_llm_call` holds exactly one Bluud entry with the desired
 * command and timeout. Returns whether the document changed.
 *
 * An existing Bluud entry is re-stamped in place rather than removed and
 * re-appended, so its position in the list — and any comment the user attached
 * to it — survives. Entries that are not Bluud's are never inspected beyond
 * identifying them, and never modified.
 */
function upsertHermesHook(doc: Document, command: string, force: boolean): boolean {
  const hooks = ensureMap(doc, "hooks");
  // `hooks:` holds a scalar or a list — not a shape an event mapping belongs
  // in. Refuse rather than overwrite whatever the user put there.
  if (hooks === null) return false;

  const seq = ensureSeq(hooks, HERMES_INJECTION_EVENT);
  if (seq === null) return false;

  const existing = findBluudEntry(seq.items as Node[]);

  if (existing === null) {
    seq.add(hermesHookEntry(command));
    return true;
  }
  if (entryIsCurrent(existing, command) && !force) {
    return false;
  }

  existing.set("command", quoted(command));
  existing.set("timeout", int(HERMES_HOOK_TIMEOUT_SECONDS));
  return true;
}

/**
 * One `hooks.pre_llm_call` list entry.
 *
 * No `matcher` key: a matcher is a regex Hermes tests against a *tool name*,
 * which `pre_llm_call` does not have — it is not a tool event. Emitting one
 * here would be meaningless at best. `pre_tool_call` is the event that takes a
 * matcher, and Bluud does not wire it: Bluud injects memory, it does not
 * police tool calls.
 */
function hermesHookEntry(command: string): YAMLMap {
  const entry = new YAMLMap();
  entry.set("command", quoted(command));
  entry.set("timeout", int(HERMES_HOOK_TIMEOUT_SECONDS));
  return entry;
}

/**
 * Identify Bluud's own entry in the event list by its `command` pointing at a
 * materialized Bluud hook script.
 *
 * Matching on the *script directory* rather than the exact command string is
 * what makes a re-install update in place instead of appending a duplicate: the
 * command is a quoted absolute path, so it legitimately differs between a
 * project checkout that moved, a renamed home directory, or a `.sh`/`.cmd`
 * switch after the user changed platforms — all cases where the old entry is
 * still ours and must be replaced, not accumulated alongside.
 */
function findBluudEntry(items: Node[]): YAMLMap | null {
  for (const item of items) {
    if (!isMap(item)) continue;
    const command = scalarAt(item as YAMLMap, "command");
    if (command !== null && commandIsBluudHook(command)) {
      return item as YAMLMap;
    }
  }
  return null;
}

/**
 * Whether a hook command invokes a Bluud-materialized script. The path is
 * normalized to forward slashes by `hookScriptCommand` before it is stored, so
 * matching the `/bluud/` directory segment plus the script's stem identifies
 * our entry without depending on where the user's home directory lives.
 */
function commandIsBluudHook(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  return normalized.includes(`/${BLUUD_DIR_NAME}/`) && normalized.includes("bluud-pull-hook");
}

/** Whether an existing entry already carries the desired command and timeout. */
function entryIsCurrent(entry: YAMLMap, command: string): boolean {
  if (scalarAt(entry, "command") !== command) return false;
  const timeout = entry.get("timeout") as unknown;
  return timeout === HERMES_HOOK_TIMEOUT_SECONDS;
}

/**
 * Hermes reads hooks only from the global config, so both install modes
 * resolve to the same file. `env.global` is intentionally unused here.
 */
function hermesDir(env: AdapterEnv): string {
  return join(env.home, ".hermes");
}

function getConfigPath(env: AdapterEnv): string {
  return join(hermesDir(env), "config.yaml");
}

/** Hermes' `pre_llm_call` contract parses stdout as a single JSON object. */
function hookScriptSpec(env: AdapterEnv): HookScriptSpec {
  return { dir: join(hermesDir(env), BLUUD_DIR_NAME), format: "hermes" };
}

function getScriptPath(env: AdapterEnv): string {
  return join(hermesDir(env), BLUUD_DIR_NAME, hookScriptFileName(process.platform !== "win32"));
}

function hasHook(text: string | null, scriptPath: string): boolean {
  const command = hookScriptCommandOrNull(scriptPath);
  // An unquotable path has no writable command, so there is nothing pending.
  if (command === null) return true;
  if (text === null) return false;
  return text.includes(command);
}

export async function uninstallHermes(env: AdapterEnv): Promise<boolean> {
  const removedScript = await removeHookScript(getScriptPath(env));

  const removedEntry = await mergeYamlFile(getConfigPath(env), (doc) => {
    const hooks = doc.get("hooks", true) as unknown;
    if (!isMap(hooks)) return false;

    const seq = (hooks as YAMLMap).get(HERMES_INJECTION_EVENT, true) as unknown;
    if (!isSeq(seq)) return false;

    const dropped = removeFromSeq(seq as never, (item) => {
      if (!isMap(item)) return false;
      const command = scalarAt(item as YAMLMap, "command");
      return command !== null && commandIsBluudHook(command);
    });
    if (dropped === 0) return false;

    // Leave no empty scaffolding behind: an event key with an empty list, and
    // then a `hooks:` mapping with no events, are both artifacts of Bluud
    // having been here. Neither is removed if the user has anything else in it.
    if ((seq as never as { items: unknown[] }).items.length === 0) {
      (hooks as YAMLMap).delete(HERMES_INJECTION_EVENT);
      if ((hooks as YAMLMap).items.length === 0) {
        doc.delete("hooks");
      }
    }
    return true;
  });

  return removedEntry || removedScript;
}
