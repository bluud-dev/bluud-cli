/**
 * `bluud doctor` — show what is configured per tool without writing.
 *
 * A pure Plan/dry-run readout (gortex `init doctor`): every check here is a
 * read (filesystem probes, an optional network GET) — nothing is written,
 * regardless of `--dry-run`/`--force`. Works without authentication (the
 * local surfaces still report), and enriches with the remote project status
 * (role, quota, token) when a session is available, matching the backend's
 * `/projects/{id}/status` endpoint, which is documented to "back `bluud
 * status`/`bluud doctor` with a single call."
 */

import pc from "picocolors";
import os from "node:os";
import { requireIdentity } from "../lib/identity.js";
import { loadProjectToken } from "../lib/config.js";
import { planAll } from "../lib/adapters/index.js";
import type { AdapterEnv } from "../lib/adapters/types.js";
import { detectAgents } from "../lib/detect.js";
import { isSkillInstalled } from "../lib/skills.js";
import { formatBytes } from "../lib/output.js";
import { getFlagBoolean } from "../lib/args.js";
import type { ProjectStatus } from "../types.js";

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

interface AgentReport {
  agent: string;
  detected: boolean;
  skillInstalled: boolean;
}

export const doctorCommand: Command = {
  name: "doctor",
  description: "Show what is configured per tool without writing",

  async run(ctx: CommandContext): Promise<number> {
    const global = getFlagBoolean(ctx.flags, "global") || getFlagBoolean(ctx.flags, "g");
    const identity = await requireIdentity(ctx.cwd);
    const projectToken = await loadProjectToken(identity.projectId);
    const env = buildEnv(ctx, global);

    const [detected, plans] = await Promise.all([detectAgents(SUPPORTED_AGENTS), planAll(env)]);
    const agentReports: AgentReport[] = SUPPORTED_AGENTS.map((agent) => ({
      agent,
      detected: detected[agent] ?? false,
      skillInstalled: isSkillInstalled(agent, global, ctx.cwd),
    }));

    const status = await fetchStatusBestEffort(ctx, identity.projectId);

    if (getFlagBoolean(ctx.flags, "json")) {
      ctx.out.writeLine(
        JSON.stringify(
          {
            identity,
            token_present: projectToken !== null,
            agents: agentReports,
            hooks: plans.map((p) => ({
              name: p.name,
              detected: p.detected,
              actions: p.actions,
            })),
            project: status,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    ctx.out.writeLine(`${pc.bold("Project identity")}`);
    ctx.out.writeLine(`  id:     ${identity.projectId}`);
    ctx.out.writeLine(`  source: ${identity.identitySource}`);
    ctx.out.writeLine(`  token:  ${projectToken !== null ? "present" : "missing"}`);

    if (status) {
      ctx.out.writeLine("");
      ctx.out.writeLine(`${pc.bold("Project")}`);
      ctx.out.writeLine(`  name:      ${status.display_name ?? "(untitled)"}`);
      ctx.out.writeLine(`  role:      ${status.role}`);
      ctx.out.writeLine(`  read_only: ${status.read_only}`);
      ctx.out.writeLine(`  memory:    ${formatBytes(status.total_size_bytes)}`);
      ctx.out.writeLine(`  quota:     ${(status.quota_usage_ratio * 100).toFixed(1)}%`);
      ctx.out.writeLine(`  token:     ${status.token_active ? "active" : "inactive"}`);
    } else if (ctx.api.isAuthenticated) {
      ctx.out.writeLine("");
      ctx.out.writeLine(pc.dim("  Project not registered yet — run `bluud` in this directory."));
    } else {
      ctx.out.writeLine("");
      ctx.out.writeLine(pc.dim("  Sign in (`bluud login`) to see role, quota, and memory size."));
    }

    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("AI tools")}`);
    for (const report of agentReports) {
      const icon = report.skillInstalled
        ? pc.green("✓")
        : report.detected
          ? pc.yellow("○")
          : pc.gray("-");
      const state = report.skillInstalled
        ? "skill installed"
        : report.detected
          ? "detected, skill not installed"
          : "not detected";
      ctx.out.writeLine(`  ${icon} ${report.agent.padEnd(16)} ${state}`);
    }

    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Hook adapters")}`);
    for (const plan of plans) {
      ctx.out.writeLine(`  ${plan.detected ? pc.green("●") : pc.gray("○")} ${plan.name}`);
      for (const action of plan.actions) {
        const icon = action.wouldChange
          ? pc.yellow("~")
          : action.present
            ? pc.green("✓")
            : pc.gray("-");
        ctx.out.writeLine(`    ${icon} ${action.description}`);
      }
    }

    return 0;
  },
};

/**
 * Best-effort remote status fetch. `doctor` must never throw for a
 * not-yet-registered project or a missing session — it degrades to the local
 * surfaces instead, unlike `status` which requires both.
 */
async function fetchStatusBestEffort(
  ctx: CommandContext,
  projectId: string,
): Promise<ProjectStatus | null> {
  if (!ctx.api.isAuthenticated) return null;
  try {
    return await ctx.api.getProjectStatus(projectId);
  } catch {
    return null;
  }
}

function buildEnv(ctx: CommandContext, global: boolean): AdapterEnv {
  return {
    cwd: ctx.cwd,
    home: os.homedir(),
    global,
    bluudBinary: process.argv[1] ?? "bluud",
  };
}
