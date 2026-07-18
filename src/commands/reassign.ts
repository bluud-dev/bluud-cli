/**
 * `bluud reassign` — reassign this directory to a different owned project.
 */

import * as p from "@clack/prompts";
import { requireIdentity } from "../lib/identity.js";
import { saveProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import type { Command, CommandContext } from "./index.js";

export const reassignCommand: Command = {
  name: "reassign",
  description: "Reassign this directory to a different owned project",

  async run(ctx: CommandContext): Promise<number> {
    if (!ctx.api.isAuthenticated) {
      throw new CliError("Not signed in. Run `bluud login`.", { code: "auth_required" });
    }

    const projects = await ctx.api.listOwnedProjects();
    if (projects.length === 0) {
      throw new CliError("You do not own any projects to reassign to.", {
        code: "project_not_found",
      });
    }

    let targetId: string;
    if (ctx.nonInteractive) {
      const arg = ctx.args[0];
      if (!arg) {
        throw new CliError(
          "Non-interactive reassign requires the target project id as an argument.",
          { code: "project_not_found" },
        );
      }
      targetId = arg;
    } else {
      const choice = await p.select({
        message: "Which project should this directory use?",
        options: projects.map((project) => ({
          value: project.project_id,
          label: project.display_name ?? project.project_id,
        })),
      });
      if (p.isCancel(choice)) {
        throw new CliError("Reassign cancelled.", { code: "cancelled" });
      }
      targetId = choice as string;
    }

    if (!projects.some((p) => p.project_id === targetId)) {
      throw new CliError("You do not own the selected project.", { code: "project_not_found" });
    }

    const token = await ctx.api.reassignProject(targetId);
    await saveProjectToken(targetId, token);

    const newIdentity = await requireIdentity(ctx.cwd);
    ctx.out.writeLine(
      `Reassigned this directory to project ${targetId}. Local identity remains ${newIdentity.projectId}.`,
    );
    return 0;
  },
};
