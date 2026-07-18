/**
 * `bluud relink` — re-link this directory to an existing project.
 */

import { requireIdentity } from "../lib/identity.js";
import { saveProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import type { Command, CommandContext } from "./index.js";

export const relinkCommand: Command = {
  name: "relink",
  description: "Re-link this directory to an existing project",

  async run(ctx: CommandContext): Promise<number> {
    if (!ctx.api.isAuthenticated) {
      throw new CliError("Not signed in. Run `bluud login`.", { code: "auth_required" });
    }

    const identity = await requireIdentity(ctx.cwd);
    const token = await ctx.api.relinkProject(identity.projectId);
    await saveProjectToken(identity.projectId, token);
    ctx.out.writeLine(`Re-linked project ${identity.projectId}. Token synced.`);
    return 0;
  },
};
