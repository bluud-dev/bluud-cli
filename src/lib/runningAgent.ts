/**
 * Detection of the AI agent the CLI is running *inside*.
 *
 * This is a different concern from `detect.ts`, and the distinction is the one
 * `BLUUD_CLI_ARCHITECTURE.md` section 2.1 calls out explicitly: `detect.ts`
 * answers "which tools are installed on this machine, so we can install the
 * skill into them", by probing well-known config directories. This module
 * answers "is a bot driving this process right now", by reading the
 * environment variables agents export into their child processes.
 *
 * The consequence is section 5.3's requirement: "When the CLI itself is run
 * *inside* an agent … it suppresses interactive prompts and uses defaults — so
 * an agent bootstrapping Bluud never hangs on a prompt." An agent has no TTY
 * to answer a clack `multiselect` with, so a prompt is not merely awkward
 * there — it deadlocks the agent's session until it times out.
 *
 * `@vercel/detect-agent` is the same dependency `vercel-labs/skills` uses for
 * this (`skills/src/detect-agent.ts`), and Bluud reuses it rather than
 * maintaining a parallel list of every agent's environment variables.
 */

import { determineAgent, type AgentResult } from "@vercel/detect-agent";

/**
 * Cache the resolved result for the process lifetime.
 *
 * `determineAgent()` is async and reads the environment (and, for some agents,
 * the filesystem). The answer cannot change within a single CLI invocation, and
 * the result is consulted on every interactive decision, so resolving it once
 * keeps repeated checks free. `skills/src/detect-agent.ts` caches for the same
 * reason.
 */
let cached: RunningAgent | null = null;

export interface RunningAgent {
  /** True when a bot — not a human at a terminal — is driving this process. */
  isAgent: boolean;
  /** The detected agent's name, or `null` when running interactively. */
  name: string | null;
}

/**
 * Environment variable that forces the answer, bypassing detection entirely.
 *
 * `1`/`true` asserts "an agent is driving me" and `0`/`false` asserts the
 * opposite. This exists because detection is heuristic: an agent Bluud has
 * never heard of exports variables `@vercel/detect-agent` does not know, and a
 * user whose terminal happens to carry a stray agent variable would otherwise
 * lose their prompts with no way to get them back. Both directions of the
 * override are honored so neither failure mode is a dead end.
 */
const OVERRIDE_ENV = "BLUUD_AGENT";

/**
 * `@vercel/detect-agent` reports a Cursor agent whenever `CURSOR_TRACE_ID` is
 * set, but Cursor exports that variable into its *integrated terminal* for
 * ordinary human sessions too (verified in the package's own detection order:
 * the `CURSOR_TRACE_ID` branch precedes the `CURSOR_AGENT` branch). Treating it
 * as an agent would silently strip prompts from a developer typing `npx @bluud/cli`
 * in Cursor's terminal — the exact interactive case Bluud most wants to serve.
 *
 * `skills/src/detect-agent.ts` hit this and requires a stronger signal before
 * enabling agent mode; Bluud applies the same refinement so the two tools agree
 * about the environment they are both installed into.
 */
function hasStrongCursorSignal(): boolean {
  return (
    Boolean(process.env.CURSOR_AGENT?.trim()) ||
    process.env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec"
  );
}

function refine(result: AgentResult): RunningAgent {
  if (!result.isAgent) {
    return { isAgent: false, name: null };
  }

  const name = result.agent.name;
  if ((name === "cursor" || name === "cursor-cli") && !hasStrongCursorSignal()) {
    return { isAgent: false, name: null };
  }

  return { isAgent: true, name };
}

function readOverride(): boolean | null {
  const raw = process.env[OVERRIDE_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return null;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  // An unrecognized value is not a silent "no": falling through to detection
  // is the safe reading, since the variable's presence does not tell us which
  // way the user meant to force it.
  return null;
}

/**
 * Resolve whether an AI agent is driving this process.
 *
 * Never throws: detection is a convenience that decides prompt suppression, so
 * a failure inside the third-party detector must degrade to "assume a human is
 * present" rather than take down the command the user actually ran.
 */
export async function detectRunningAgent(): Promise<RunningAgent> {
  if (cached) return cached;

  const override = readOverride();
  if (override !== null) {
    cached = { isAgent: override, name: override ? "override" : null };
    return cached;
  }

  try {
    cached = refine(await determineAgent());
  } catch {
    cached = { isAgent: false, name: null };
  }
  return cached;
}

/**
 * True when the CLI is running inside a detected AI agent, in which case every
 * interactive prompt must be skipped in favor of its default.
 */
export async function isRunningInAgent(): Promise<boolean> {
  return (await detectRunningAgent()).isAgent;
}

/** Reset the memoized result. Exists so tests can vary the environment. */
export function resetRunningAgentCache(): void {
  cached = null;
}
