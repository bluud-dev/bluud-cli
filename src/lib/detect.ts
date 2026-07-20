/**
 * Detection of AI coding tools installed on this machine.
 *
 * The actual per-tool probes (well-known config directories, PATH lookups,
 * and the handful of bespoke heuristics some tools need) live in
 * `agentRegistry.ts`, the single native registry this module, `skills.ts`,
 * and every command share — this file is only the small, stable batch API
 * the commands import; it never touches disk itself.
 */

import { detectAgent as detectRegistryAgent } from "./agentRegistry.js";

export type AgentDetection = Record<string, boolean>;

/**
 * Detect whether a single agent appears installed on this machine.
 * Unknown agent names resolve to `false` rather than throwing, so callers can
 * probe speculatively.
 */
export async function detectAgent(agent: string): Promise<boolean> {
  return detectRegistryAgent(agent);
}

/** Detect every agent in `agents`, returning a name → detected map. */
export async function detectAgents(agents: string[]): Promise<AgentDetection> {
  const entries = await Promise.all(
    agents.map(async (agent) => [agent, await detectAgent(agent)] as const),
  );
  return Object.fromEntries(entries);
}
