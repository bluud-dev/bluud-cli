/**
 * `bluud uninstall` — remove the Bluud skill/hooks from selected tools.
 */

import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import os from "node:os";
import { CliError } from "../lib/error.js";
import { uninstallClaudeCode } from "../lib/adapters/claudecode.js";
import { uninstallCodex } from "../lib/adapters/codex.js";
import { uninstallGeminiCli } from "../lib/adapters/geminicli.js";
import { uninstallAntigravity } from "../lib/adapters/antigravity.js";
import { uninstallKimi } from "../lib/adapters/kimi.js";
import { uninstallCline } from "../lib/adapters/cline.js";
import { adapters as hookAdapters } from "../lib/adapters/index.js";
import type { AdapterEnv } from "../lib/adapters/types.js";
import { getFlagArray, getFlagBoolean } from "../lib/args.js";
import type { Command, CommandContext } from "./index.js";

const SUPPORTED_AGENTS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "antigravity",
  "kimi-code-cli",
  "cline",
  "cursor",
  "windsurf",
  "aider",
  "github-copilot",
];

const ADAPTER_UNINSTALLERS: Partial<Record<string, (env: AdapterEnv) => Promise<boolean>>> = {
  "claude-code": uninstallClaudeCode,
  codex: uninstallCodex,
  "gemini-cli": uninstallGeminiCli,
  antigravity: uninstallAntigravity,
  "kimi-code-cli": uninstallKimi,
  cline: uninstallCline,
};

interface UninstallReport {
  agent: string;
  skillWasInstalled: boolean;
  skillRemoved: boolean;
  hookWasConfigured: boolean;
  hookRemoved: boolean;
}

export const uninstallCommand: Command = {
  name: "uninstall",
  description: "Remove the Bluud skill/hooks from selected tools",

  async run(ctx: CommandContext): Promise<number> {
    const jsonMode = getFlagBoolean(ctx.flags, "json");
    const dryRun = getFlagBoolean(ctx.flags, "dry-run");
    const effectiveCtx: CommandContext = { ...ctx, nonInteractive: ctx.nonInteractive || jsonMode };

    const agents = await selectAgents(effectiveCtx);
    if (agents.length === 0) {
      if (jsonMode) {
        ctx.out.writeLine(JSON.stringify({ dry_run: dryRun, agents: [] }, null, 2));
      } else {
        ctx.out.writeLine("No tools selected. Nothing to uninstall.");
      }
      return 0;
    }

    const home = os.homedir();
    const global = getFlagBoolean(ctx.flags, "global") || getFlagBoolean(ctx.flags, "g");
    const env: AdapterEnv = { cwd: ctx.cwd, home, global, bluudBinary: process.argv[1] ?? "bluud" };

    const reports: UninstallReport[] = [];
    for (const agent of agents) {
      const skillWasInstalled = skillFilesPresent(agent, ctx.cwd, home);
      const hookUninstaller = ADAPTER_UNINSTALLERS[agent];
      let hookWasConfigured = false;
      if (hookUninstaller) {
        hookWasConfigured = await wouldRemoveHook(agent, env);
      }

      let skillRemoved = false;
      let hookRemoved = false;
      if (!dryRun) {
        if (skillWasInstalled) {
          await removeSkillFiles(agent, ctx.cwd, home);
          skillRemoved = true;
        }
        if (hookUninstaller) {
          hookRemoved = await hookUninstaller(env);
        }
      }

      reports.push({ agent, skillWasInstalled, skillRemoved, hookWasConfigured, hookRemoved });
    }

    if (jsonMode) {
      ctx.out.writeLine(JSON.stringify({ dry_run: dryRun, agents: reports }, null, 2));
      return 0;
    }

    if (dryRun) {
      ctx.out.writeLine("Would remove Bluud from:");
      for (const r of reports) {
        const parts: string[] = [];
        if (r.skillWasInstalled) parts.push("skill");
        if (r.hookWasConfigured) parts.push("hook");
        ctx.out.writeLine(`  ${r.agent}: ${parts.length > 0 ? parts.join(", ") : "nothing found"}`);
      }
      return 0;
    }

    ctx.out.writeLine(`Uninstalled Bluud from: ${agents.join(", ")}`);
    return 0;
  },
};

/**
 * Whether an uninstall would remove a hook for `agent`, without writing
 * anything — used for the `--dry-run` report. Adapters have no standalone
 * `plan`-for-removal method, so this re-derives detection the same way
 * `Adapter.plan()` does (present config dir + an existing action) as a
 * reasonable proxy for "a hook uninstall has something to do here."
 */
async function wouldRemoveHook(agent: string, env: AdapterEnv): Promise<boolean> {
  const adapter = hookAdapters.find((a) => a.name === agent);
  if (!adapter) return false;
  const plan = await adapter.plan(env);
  return plan.detected && plan.actions.some((a) => a.present);
}

async function selectAgents(ctx: CommandContext): Promise<string[]> {
  const agentFlag = getFlagArray(ctx.flags, "agent").concat(getFlagArray(ctx.flags, "a"));
  const skipFlag = getFlagArray(ctx.flags, "agents-skip");

  if (agentFlag.length > 0) {
    const invalid = agentFlag.filter((a) => !SUPPORTED_AGENTS.includes(a));
    if (invalid.length > 0) {
      throw new CliError(`Unknown agent(s): ${invalid.join(", ")}`, { code: "config_error" });
    }
    return agentFlag.filter((a) => !skipFlag.includes(a));
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

/**
 * The exact per-agent skill file/directory targets removed by
 * `removeSkillFiles`. Kept separate from `skills.ts`'s `resolveSkillTargetDir`
 * (used by the *install* copy-fallback) because the two intentionally diverge
 * for the four non-hook, single-surface tools: Cursor/Windsurf/Aider/GitHub
 * Copilot are each a single instruction file (`.windsurfrules`, `AIDER.md`,
 * …) rather than a directory holding a nested `bluud-memory` skill package.
 */
function skillTargets(
  agent: string,
  cwd: string,
  home: string,
): { project: string; global: string | null } | null {
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
    antigravity: {
      project: `${cwd}/.agents/skills/bluud-memory`,
      global: `${home}/.gemini/antigravity/skills/bluud-memory`,
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

  return targets[agent] ?? null;
}

function skillFilesPresent(agent: string, cwd: string, home: string): boolean {
  const entry = skillTargets(agent, cwd, home);
  if (!entry) return false;
  return existsSync(entry.project) || (entry.global !== null && existsSync(entry.global));
}

async function removeSkillFiles(agent: string, cwd: string, home: string): Promise<void> {
  const entry = skillTargets(agent, cwd, home);
  if (!entry) return;

  const { rm } = await import("node:fs/promises");
  await rm(entry.project, { recursive: true, force: true });
  if (entry.global) {
    await rm(entry.global, { recursive: true, force: true });
  }
}
