/**
 * Kiro hook adapter.
 *
 * Kiro's hook architecture is unlike every other tool Bluud wires, and the
 * difference is not cosmetic — it changes what an integration can even do.
 *
 * A Kiro agent hook is a **declarative JSON document** under `.kiro/hooks/`,
 * shaped `{name, version, description, when, then}`. The `when` block names a
 * trigger (`userTriggered`, `fileEdited` with glob `patterns`, `preToolUse`
 * with `toolTypes`); the `then` block is `{"type": "askAgent", "prompt": ...}`.
 *
 * That `then` type is the whole story: **a Kiro hook cannot execute a
 * command.** It can only hand the agent a prompt. There is no equivalent of
 * Claude Code's `{"type": "command"}`, no stdout that becomes context, and
 * therefore nothing for a materialized `bluud-pull-hook.sh` to be referenced
 * by. Wiring Kiro the way `claudecode.ts` wires Claude Code is not a
 * simplification — it is impossible.
 *
 * So Bluud's Kiro integration is **agent-mediated**: the agent is instructed to
 * run `bluud pull --inject --index` itself, and Kiro's own mechanisms decide
 * when it is told to. Two native surfaces carry that, and both are needed
 * because they cover different moments:
 *
 *   1. `.kiro/steering/bluud-memory.md` with `inclusion: always` — a steering
 *      document is Kiro's standing-instruction mechanism, folded into every
 *      agent session automatically. This is the always-on half, and the
 *      closest thing Kiro has to a session-start hook.
 *
 *   2. `.kiro/hooks/bluud-memory.json` with `when.type: userTriggered` — an
 *      explicit, user-invocable "reload project memory" action for refreshing
 *      mid-session after memory has been pushed from elsewhere. This is the
 *      on-demand half.
 *
 * Scope: project only. Kiro's agent-hook engine fires only in the workspace
 * that owns the hooks, and steering documents are likewise workspace-scoped,
 * so a global install has nothing to write. `detect` still reports Kiro
 * accurately in global mode; `plan` simply carries no actions, which is how
 * `bluud doctor` reports "installed, but nothing to do at this scope" rather
 * than inventing a user-level path Kiro would never read.
 *
 * Ownership: JSON admits no comments, so the `bluud:managed` marker every
 * other artifact carries cannot ride in the hook file. Ownership is instead
 * established by the `name` field's `Bluud:` prefix — the same shape gortex
 * uses to identify its own Kiro artifacts. The steering document is Markdown
 * and does carry the standard marker, as an HTML comment.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import { atomicWriteFile, readTextFile } from "./writer.js";
import { isManagedByBluud } from "./hookScript.js";

const ADAPTER_NAME = "kiro-cli";

const HOOK_FILE_NAME = "bluud-memory.json";
const STEERING_FILE_NAME = "bluud-memory.md";

/**
 * Prefix identifying a Bluud-authored Kiro hook. Kiro surfaces `name` in its
 * hook UI, so this doubles as the label a user sees.
 */
const HOOK_NAME_PREFIX = "Bluud:";

/**
 * The instruction both surfaces carry.
 *
 * `--index` and not a bare `--inject`: the index is titles, ids, hierarchy and
 * descriptions with no node bodies. An agent reading it at the start of a task
 * has no user request to judge relevance against yet, so it loads specific
 * nodes with `bluud pull --inject --id <uuid>` once it does. Naming that
 * follow-up command here is what makes the injected context self-sufficient —
 * the agent may be acting on it without having separately read the skill.
 */
const PULL_COMMAND = "bluud pull --inject --index";

const HOOK_DOCUMENT = {
  name: `${HOOK_NAME_PREFIX} Load Project Memory`,
  version: "1.0.0",
  description: "Load this project's Bluud memory index into the conversation.",
  when: { type: "userTriggered" },
  then: {
    type: "askAgent",
    prompt:
      `Run \`${PULL_COMMAND}\` in the workspace root and read its output. ` +
      "It prints this project's Bluud memory index: one entry per node with its id, " +
      "title breadcrumb, last-updated time, and description — no node bodies. " +
      "Treat it as established project context. " +
      "When an entry looks relevant to the current task, load its full content with " +
      "`bluud pull --inject --id <uuid>` before acting. " +
      "If the command fails, say so once and continue without project memory; never block on it.",
  },
} as const;

const STEERING_DOCUMENT = `---
inclusion: always
---

<!-- bluud:managed -->

# Project memory (Bluud)

This workspace's durable project memory is managed by Bluud. Kiro agent hooks
can only prompt the agent, never run a command, so loading memory is your step
to take — it does not happen automatically.

1. At the start of a coding task, run \`${PULL_COMMAND}\` and read its output.
   It is the memory *index*: one entry per node with its id, title breadcrumb,
   last-updated time, and description. It contains no node bodies.
2. Treat those entries as established context for this project — prior
   decisions, conventions, and constraints that already hold.
3. When an entry looks relevant to what you are doing, load its full content
   with \`bluud pull --inject --id <uuid>\`. Load only what you need.
4. If any \`bluud\` command fails, mention it once and continue without project
   memory. Never block or interrupt the session over it.

This file is generated by the Bluud CLI. Removing the \`bluud:managed\` comment
above makes Bluud treat it as yours and stop rewriting it.
`;

export const kiroAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    if (existsSync(join(env.cwd, ".kiro"))) return true;
    return existsSync(join(env.home, ".kiro"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const detected = await this.detect(env);

    // Global mode has nothing to write; see the module header on scope.
    if (env.global) {
      return { name: ADAPTER_NAME, detected, actions: [] };
    }

    const hookPath = getHookPath(env);
    const steeringPath = getSteeringPath(env);

    const existingHook = await readTextFile(hookPath);
    const existingSteering = await readTextFile(steeringPath);

    const hookForeign = existingHook !== null && !isBluudHookDocument(existingHook);
    const steeringForeign = existingSteering !== null && !isManagedByBluud(existingSteering);

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path: steeringPath,
          description: steeringForeign
            ? "Bluud memory steering document (skipped — an existing user-authored document is present)"
            : "Bluud memory steering document (inclusion: always)",
          present: existingSteering !== null,
          wouldChange: detected && !steeringForeign && existingSteering !== STEERING_DOCUMENT,
        },
        {
          path: hookPath,
          description: hookForeign
            ? "Bluud memory agent hook (skipped — an existing user-authored hook is present)"
            : "Bluud memory agent hook (userTriggered)",
          present: existingHook !== null,
          wouldChange: detected && !hookForeign && existingHook !== renderHookDocument(),
        },
      ],
    };
  },

  async apply(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult> {
    const plan = await this.plan(env);
    if (!plan.detected || env.global || opts.dryRun) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    let applied = false;

    const steeringPath = getSteeringPath(env);
    const existingSteering = await readTextFile(steeringPath);
    if (existingSteering === null || isManagedByBluud(existingSteering)) {
      if (existingSteering !== STEERING_DOCUMENT) {
        await atomicWriteFile(steeringPath, STEERING_DOCUMENT);
      }
      applied = true;
    }

    const hookPath = getHookPath(env);
    const existingHook = await readTextFile(hookPath);
    const desiredHook = renderHookDocument();
    if (existingHook === null || isBluudHookDocument(existingHook)) {
      if (existingHook !== desiredHook) {
        await atomicWriteFile(hookPath, desiredHook);
      }
      applied = true;
    }

    return { name: ADAPTER_NAME, applied, actions: plan.actions };
  },
};

function getHookPath(env: AdapterEnv): string {
  return join(env.cwd, ".kiro", "hooks", HOOK_FILE_NAME);
}

function getSteeringPath(env: AdapterEnv): string {
  return join(env.cwd, ".kiro", "steering", STEERING_FILE_NAME);
}

/** Kiro reads this as JSON, so it is serialized as JSON — no marker comment. */
function renderHookDocument(): string {
  return `${JSON.stringify(HOOK_DOCUMENT, null, 2)}\n`;
}

/**
 * Whether a `.kiro/hooks/` document is one Bluud wrote.
 *
 * Parses rather than substring-matches: a user hook whose *prompt* happens to
 * mention Bluud (entirely plausible — "remind me to run bluud push") must not
 * be mistaken for Bluud's own and silently overwritten. Only the `name` field
 * establishes ownership. A file that is not valid JSON is treated as foreign,
 * which is the safe direction: Bluud declines to touch it.
 */
function isBluudHookDocument(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const name = (parsed as Record<string, unknown>)["name"];
    return typeof name === "string" && name.startsWith(HOOK_NAME_PREFIX);
  } catch {
    return false;
  }
}

export async function uninstallKiro(env: AdapterEnv): Promise<boolean> {
  // Symmetric with apply: nothing is written at global scope, so nothing is
  // removed there either.
  if (env.global) return false;

  let removed = false;

  const steeringPath = getSteeringPath(env);
  const steering = await readTextFile(steeringPath);
  if (steering !== null && isManagedByBluud(steering)) {
    await rm(steeringPath, { force: true });
    removed = true;
  }

  const hookPath = getHookPath(env);
  const hook = await readTextFile(hookPath);
  if (hook !== null && isBluudHookDocument(hook)) {
    await rm(hookPath, { force: true });
    removed = true;
  }

  return removed;
}
