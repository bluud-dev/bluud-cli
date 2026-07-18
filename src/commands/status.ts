/**
 * `bluud status` — show project identity, token status, and memory size.
 */

import pc from "picocolors";
import { requireIdentity } from "../lib/identity.js";
import { loadProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import { getFlagBoolean } from "../lib/args.js";
import type { Command, CommandContext } from "./index.js";

export const statusCommand: Command = {
  name: "status",
  description: "Show project identity, token status, and memory size",

  async run(ctx: CommandContext): Promise<number> {
    if (!ctx.api.isAuthenticated) {
      throw new CliError("Not signed in. Run `bluud login`.", { code: "auth_required" });
    }

    const identity = await requireIdentity(ctx.cwd);
    const projectToken = await loadProjectToken(identity.projectId);
    const status = await ctx.api.getProjectStatus(identity.projectId);

    if (getFlagBoolean(ctx.flags, "json")) {
      ctx.out.writeLine(
        JSON.stringify(
          {
            identity,
            token_present: projectToken !== null,
            status,
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
    if (identity.gitRemote) ctx.out.writeLine(`  remote: ${identity.gitRemote}`);
    ctx.out.writeLine(`  path:   ${identity.path}`);
    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Project")}`);
    ctx.out.writeLine(`  name:   ${status.display_name ?? "(untitled)"}`);
    ctx.out.writeLine(`  role:   ${status.role}`);
    ctx.out.writeLine(`  read_only: ${status.read_only}`);
    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Memory")}`);
    ctx.out.writeLine(`  size:   ${formatBytes(status.total_size_bytes)}`);
    ctx.out.writeLine(`  quota:  ${(status.quota_usage_ratio * 100).toFixed(1)}%`);
    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Token")}`);
    ctx.out.writeLine(`  local:  ${projectToken !== null ? "present" : "missing"}`);
    ctx.out.writeLine(`  active: ${status.token_active ? "yes" : "no"}`);

    return 0;
  },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / Math.pow(1000, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
