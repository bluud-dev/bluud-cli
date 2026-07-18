/**
 * `bluud` (default) — onboard the current directory.
 *
 * Flow:
 *   1. Ensure authentication.
 *   2. Compute project identity.
 *   3. Register or confirm project.
 *   4. Store project token.
 *   5. Install skill into detected AI tools.
 *   6. Apply hook adapters for hook-capable tools.
 *   7. Print summary.
 */

import pc from "picocolors";
import os from "node:os";
import { basename } from "node:path";
import { requireIdentity } from "../lib/identity.js";
import { saveAuth, saveProjectToken } from "../lib/config.js";
import { loginWithBrowser, loginWithToken } from "../lib/auth.js";
import {
  promptSelect,
  promptMultiselect,
  promptPassword,
  spinner as createSpinner,
  assertInteractive,
} from "../lib/prompts.js";
import { bundledSkillPath, installSkill } from "../lib/skills.js";
import { applyAll } from "../lib/adapters/index.js";
import type { AdapterEnv } from "../lib/adapters/types.js";
import { CliError } from "../lib/error.js";
import { getFlagBoolean, getFlagArray, getFlagString } from "../lib/args.js";
import type { Command, CommandContext } from "./index.js";

const SUPPORTED_AGENTS = ["claude-code", "codex", "cursor", "windsurf", "aider", "github-copilot"];

export const installCommand: Command = {
  name: "install",
  description: "Onboard the current directory (default command)",

  async run(ctx: CommandContext): Promise<number> {
    await ensureAuth(ctx);

    const spinner = createSpinner();
    spinner.start("Computing project identity…");
    const identity = await requireIdentity(ctx.cwd);
    spinner.stop(`Project identity: ${identity.projectId}`);

    spinner.start("Registering project…");
    const displayName = basename(ctx.cwd);
    const registration = await ctx.api.registerProject(identity, displayName);
    await saveProjectToken(registration.project_id, registration.token);
    spinner.stop(registration.is_new ? "Project registered." : "Project membership confirmed.");

    const agents = await selectAgents(ctx);
    if (agents.length === 0) {
      ctx.out.writeLine("No tools selected. Skill not installed.");
      return 0;
    }

    spinner.start("Installing Bluud skill into your tools…");
    const skillPath = bundledSkillPath();
    const installResults: Array<{ agent: string; mode: string; installed: boolean }> = [];
    for (const agent of agents) {
      const result = await installSkill({
        skillName: "bluud-memory",
        skillPath,
        agent,
        global: getFlagBoolean(ctx.flags, "global") || getFlagBoolean(ctx.flags, "g"),
        copy: getFlagBoolean(ctx.flags, "copy"),
        cwd: ctx.cwd,
      });
      installResults.push({ agent, mode: result.mode, installed: result.installed });
    }
    spinner.stop("Skill installation complete.");

    spinner.start("Configuring lifecycle hooks…");
    const env = buildEnv(ctx);
    const adapterResults = await applyAll(env, {
      dryRun: getFlagBoolean(ctx.flags, "dry-run"),
      force: getFlagBoolean(ctx.flags, "force"),
    });
    spinner.stop("Hooks configured.");

    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Summary")}`);
    ctx.out.writeLine(`  project: ${registration.project_id}`);
    ctx.out.writeLine(`  token:   stored at ~/.bluud/projects/${registration.project_id}/token`);
    ctx.out.writeLine("");
    ctx.out.writeLine("  Installed tools:");
    for (const r of installResults) {
      const icon = r.installed ? pc.green("✓") : pc.red("✗");
      ctx.out.writeLine(`    ${icon} ${r.agent} (${r.mode})`);
    }
    ctx.out.writeLine("");
    ctx.out.writeLine("  Hook adapters:");
    for (const r of adapterResults) {
      const icon = r.applied
        ? pc.green("✓")
        : r.actions.some((a) => a.wouldChange)
          ? pc.yellow("~")
          : pc.gray("-");
      ctx.out.writeLine(`    ${icon} ${r.name}`);
    }

    return 0;
  },
};

async function ensureAuth(ctx: CommandContext): Promise<void> {
  if (ctx.api.isAuthenticated) return;

  const pat = getFlagString(ctx.flags, "token");
  if (pat) {
    const session = await loginWithToken(ctx.api, pat);
    await saveAuth(session, true);
    return;
  }

  assertInteractive(ctx.nonInteractive, "Not signed in. Run `bluud login` or pass --token <PAT>.");

  const method = await promptSelect<"browser" | "token">("Sign in to Bluud", [
    { value: "browser", label: "Open browser" },
    { value: "token", label: "Paste personal access token" },
  ]);

  if (method === "token") {
    const value = await promptPassword(
      "Paste your personal access token from https://bluud.dev/settings/tokens",
    );
    const session = await loginWithToken(ctx.api, value);
    await saveAuth(session, true);
    return;
  }

  const session = await loginWithBrowser(ctx.api);
  await saveAuth(session, false);
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

  const selected = await promptMultiselect(
    "Select AI tools to install Bluud into:",
    SUPPORTED_AGENTS.map((a) => ({ value: a, label: a })),
    SUPPORTED_AGENTS,
  );

  return selected.filter((a) => !skipFlag.includes(a));
}

function buildEnv(ctx: CommandContext): AdapterEnv {
  return {
    cwd: ctx.cwd,
    home: os.homedir(),
    global: getFlagBoolean(ctx.flags, "global") || getFlagBoolean(ctx.flags, "g"),
    bluudBinary: process.argv[1] ?? "bluud",
  };
}
