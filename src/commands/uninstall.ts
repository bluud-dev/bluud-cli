/**
 * `bluud uninstall` — remove the Bluud skill/hooks from selected tools.
 */

import * as p from "@clack/prompts";
import os from "node:os";
import { CliError } from "../lib/error.js";
import { uninstallClaudeCode } from "../lib/adapters/claudecode.js";
import { uninstallCodex } from "../lib/adapters/codex.js";
import { uninstallGeminiCli } from "../lib/adapters/geminicli.js";
import { uninstallKimi } from "../lib/adapters/kimi.js";
import { uninstallCline } from "../lib/adapters/cline.js";
import type { AdapterEnv } from "../lib/adapters/types.js";
import { getFlagArray, getFlagBoolean } from "../lib/args.js";
import type { Command, CommandContext } from "./index.js";

const SUPPORTED_AGENTS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "kimi-code-cli",
  "cline",
  "cursor",
  "windsurf",
  "aider",
  "github-copilot",
];

const ADAPTER_UNINSTALLERS: Record<string, (env: AdapterEnv) => Promise<boolean>> = {
  "claude-code": uninstallClaudeCode,
  codex: uninstallCodex,
  "gemini-cli": uninstallGeminiCli,
  "kimi-code-cli": uninstallKimi,
  cline: uninstallCline,
};

export const uninstallCommand: Command = {
  name: "uninstall",
  description: "Remove the Bluud skill/hooks from selected tools",

  async run(ctx: CommandContext): Promise<number> {
    const agents = await selectAgents(ctx);
    if (agents.length === 0) {
      ctx.out.writeLine("No tools selected. Nothing to uninstall.");
      return 0;
    }

    const home = os.homedir();
    const global = getFlagBoolean(ctx.flags, "global") || getFlagBoolean(ctx.flags, "g");
    const env: AdapterEnv = { cwd: ctx.cwd, home, global, bluudBinary: process.argv[1] ?? "bluud" };

    for (const agent of agents) {
      await removeSkillFiles(agent, ctx.cwd, home);
      const uninstallAdapter = ADAPTER_UNINSTALLERS[agent];
      if (uninstallAdapter) {
        await uninstallAdapter(env);
      }
    }

    ctx.out.writeLine(`Uninstalled Bluud from: ${agents.join(", ")}`);
    return 0;
  },
};

async function selectAgents(ctx: CommandContext): Promise<string[]> {
  const agentFlag = getFlagArray(ctx.flags, "agent").concat(getFlagArray(ctx.flags, "a"));
  const skipFlag = getFlagArray(ctx.flags, "agents-skip");

  if (agentFlag.length > 0) {
    return agentFlag.filter((a) => SUPPORTED_AGENTS.includes(a) && !skipFlag.includes(a));
  }

  if (ctx.nonInteractive) {
    return SUPPORTED_AGENTS.filter((a) => !skipFlag.includes(a));
  }

  const selected = await p.multiselect({
    message: "Select tools to uninstall Bluud from:",
    options: SUPPORTED_AGENTS.map((a) => ({ value: a, label: a })),
    initialValues: SUPPORTED_AGENTS,
  });

  if (p.isCancel(selected)) {
    throw new CliError("Uninstall cancelled.", { code: "cancelled" });
  }

  const result = selected as string[];
  return result.filter((a) => !skipFlag.includes(a));
}

async function removeSkillFiles(agent: string, cwd: string, home: string): Promise<void> {
  const targets: Record<string, { project: string; global: string | null }> = {
    "claude-code": {
      project: `${cwd}/.claude/skills/bluud-memory`,
      global: `${home}/.claude/skills/bluud-memory`,
    },
    codex: {
      project: `${cwd}/.codex/skills/bluud-memory`,
      global: `${home}/.codex/skills/bluud-memory`,
    },
    "gemini-cli": {
      project: `${cwd}/.agents/skills/bluud-memory`,
      global: `${home}/.gemini/skills/bluud-memory`,
    },
    "kimi-code-cli": {
      project: `${cwd}/.agents/skills/bluud-memory`,
      global: `${home}/.agents/skills/bluud-memory`,
    },
    cline: {
      project: `${cwd}/.agents/skills/bluud-memory`,
      global: `${home}/.agents/skills/bluud-memory`,
    },
    cursor: { project: `${cwd}/.cursor/rules/bluud-memory.mdc`, global: null },
    windsurf: { project: `${cwd}/.windsurfrules`, global: null },
    aider: { project: `${cwd}/AIDER.md`, global: null },
    "github-copilot": { project: `${cwd}/.github/copilot-instructions.md`, global: null },
  };

  const entry = targets[agent];
  if (!entry) return;

  const { rm } = await import("node:fs/promises");
  await rm(entry.project, { recursive: true, force: true });
  if (entry.global) {
    await rm(entry.global, { recursive: true, force: true });
  }
}
