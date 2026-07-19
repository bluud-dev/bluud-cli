/**
 * `bluud` (default) — onboard the current directory.
 *
 * Flow:
 *   1. Ensure authentication.
 *   2. Detect installed AI tools; let the user confirm/select via multiselect.
 *   3. Compute project identity.
 *   4. Register or confirm project.
 *   5. Store project token.
 *   6. Install skill into selected AI tools.
 *   7. Apply hook adapters for hook-capable tools.
 *   8. Print summary.
 */

import pc from "picocolors";
import os from "node:os";
import { basename } from "node:path";
import { requireIdentity } from "../lib/identity.js";
import { saveAuth, saveProjectToken } from "../lib/config.js";
import { loginWithBrowser, loginWithToken } from "../lib/auth.js";
import { detectAgents } from "../lib/detect.js";
import {
  promptSelect,
  promptMultiselect,
  promptPassword,
  spinner as createSpinner,
  assertInteractive,
} from "../lib/prompts.js";
import {
  BLUUD_SKILL_NAME,
  bundledSkillPath,
  installSkill,
  type SkillsInstallResult,
} from "../lib/skills.js";
import { applyAll } from "../lib/adapters/index.js";
import type { AdapterEnv, AdapterResult } from "../lib/adapters/types.js";
import { CliError } from "../lib/error.js";
import { getFlagBoolean, getFlagArray, getFlagString } from "../lib/args.js";
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

export const installCommand: Command = {
  name: "install",
  description: "Onboard the current directory (default command)",

  async run(ctx: CommandContext): Promise<number> {
    const jsonMode = getFlagBoolean(ctx.flags, "json");
    const dryRun = getFlagBoolean(ctx.flags, "dry-run");
    // JSON output is for scripts, not humans at a prompt — treat it the same
    // as --yes for every interactive decision downstream.
    const effectiveCtx: CommandContext = {
      ...ctx,
      nonInteractive: ctx.nonInteractive || jsonMode,
    };

    await ensureAuth(effectiveCtx);

    const spinner = createSpinner();
    const start = (msg: string) => {
      if (!jsonMode) spinner.start(msg);
    };
    const stop = (msg: string) => {
      if (!jsonMode) spinner.stop(msg);
    };

    const detected = await detectAgents(SUPPORTED_AGENTS);

    start("Computing project identity…");
    const identity = await requireIdentity(effectiveCtx.cwd);
    stop(`Project identity: ${identity.projectId}`);

    start("Registering project…");
    const displayName = basename(effectiveCtx.cwd);
    const registration = await effectiveCtx.api.registerProject(identity, displayName);
    await saveProjectToken(registration.project_id, registration.token);
    stop(registration.is_new ? "Project registered." : "Project membership confirmed.");

    const agents = await selectAgents(effectiveCtx, detected);

    const installResults: SkillsInstallResult[] = [];
    let adapterResults: AdapterResult[] = [];

    if (agents.length === 0) {
      if (!jsonMode) ctx.out.writeLine("No tools selected. Skill not installed.");
    } else {
      start("Installing Bluud skill into your tools…");
      const skillPath = bundledSkillPath();
      for (const agent of agents) {
        const result = await installSkill({
          skillName: BLUUD_SKILL_NAME,
          skillPath,
          agent,
          global: getFlagBoolean(ctx.flags, "global") || getFlagBoolean(ctx.flags, "g"),
          copy: getFlagBoolean(ctx.flags, "copy"),
          cwd: effectiveCtx.cwd,
          dryRun,
        });
        installResults.push(result);
      }
      stop("Skill installation complete.");

      start("Configuring lifecycle hooks…");
      const env = buildEnv(effectiveCtx);
      adapterResults = await applyAll(env, {
        dryRun,
        force: getFlagBoolean(ctx.flags, "force"),
      });
      stop("Hooks configured.");
    }

    if (jsonMode) {
      ctx.out.writeLine(
        JSON.stringify(
          {
            identity,
            project: {
              project_id: registration.project_id,
              display_name: registration.display_name,
              is_new: registration.is_new,
            },
            detected_agents: Object.entries(detected)
              .filter(([, present]) => present)
              .map(([name]) => name),
            selected_agents: agents,
            dry_run: dryRun,
            skill_install: installResults,
            hooks: adapterResults,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Summary")}`);
    ctx.out.writeLine(`  project: ${registration.project_id}`);
    ctx.out.writeLine(`  token:   stored at ~/.bluud/projects/${registration.project_id}/token`);
    if (agents.length > 0) {
      ctx.out.writeLine("");
      ctx.out.writeLine("  Installed tools:");
      for (const r of installResults) {
        const icon = r.installed ? pc.green("✓") : dryRun ? pc.yellow("~") : pc.red("✗");
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

async function selectAgents(
  ctx: CommandContext,
  detected: Record<string, boolean>,
): Promise<string[]> {
  const agentFlag = getFlagArray(ctx.flags, "agent").concat(getFlagArray(ctx.flags, "a"));
  const skipFlag = getFlagArray(ctx.flags, "agents-skip");
  const detectedAgents = SUPPORTED_AGENTS.filter((a) => detected[a]);

  if (agentFlag.length > 0) {
    const invalid = agentFlag.filter((a) => !SUPPORTED_AGENTS.includes(a));
    if (invalid.length > 0) {
      throw new CliError(`Unknown agent(s): ${invalid.join(", ")}`, { code: "config_error" });
    }
    return agentFlag.filter((a) => !skipFlag.includes(a));
  }

  if (ctx.nonInteractive) {
    return detectedAgents.filter((a) => !skipFlag.includes(a));
  }

  const selected = await promptMultiselect(
    "Select AI tools to install Bluud into:",
    SUPPORTED_AGENTS.map((a) => ({ value: a, label: a })),
    detectedAgents,
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
