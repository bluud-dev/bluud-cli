/**
 * Detection of AI coding tools installed on this machine.
 *
 * Mirrors the well-known-directory probing pattern from `vercel-labs/skills`
 * (`skills/src/agents.ts`): each tool is considered "installed" if its
 * conventional config/home directory exists, respecting the same environment
 * variable overrides the tool itself honors (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, …). This never touches disk beyond `existsSync` — it is a
 * pure read, safe to call before authentication or any write.
 *
 * `aider` has no persistent home directory (it is a pip-installed CLI), so it
 * is detected via `PATH` lookup instead, matching `commandExists` in
 * `skills.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { commandExists } from "./skills.js";

export type AgentDetection = Record<string, boolean>;

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(os.homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(os.homedir(), ".codex");
}

const DIRECTORY_PROBES: Record<string, () => string[]> = {
  "claude-code": () => [claudeHome()],
  codex: () => [codexHome(), "/etc/codex"],
  "gemini-cli": () => [join(os.homedir(), ".gemini")],
  antigravity: () => [join(os.homedir(), ".gemini", "antigravity")],
  "kimi-code-cli": () => [join(os.homedir(), ".kimi-code"), join(os.homedir(), ".kimi")],
  cline: () => [join(os.homedir(), ".cline")],
  cursor: () => [join(os.homedir(), ".cursor")],
  windsurf: () => [join(os.homedir(), ".codeium", "windsurf")],
  "github-copilot": () => [join(os.homedir(), ".copilot")],
};

/** Agents detected by PATH lookup rather than a config directory. */
const COMMAND_PROBES: Record<string, string> = {
  aider: "aider",
};

/**
 * Detect whether a single agent appears installed on this machine.
 * Unknown agent names resolve to `false` rather than throwing, so callers can
 * probe speculatively.
 */
export async function detectAgent(agent: string): Promise<boolean> {
  const dirs = DIRECTORY_PROBES[agent];
  if (dirs) {
    return dirs().some((dir) => existsSync(dir));
  }
  const command = COMMAND_PROBES[agent];
  if (command) {
    return commandExists(command);
  }
  return false;
}

/** Detect every agent in `agents`, returning a name → detected map. */
export async function detectAgents(agents: string[]): Promise<AgentDetection> {
  const entries = await Promise.all(
    agents.map(async (agent) => [agent, await detectAgent(agent)] as const),
  );
  return Object.fromEntries(entries);
}
