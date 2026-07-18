/**
 * `bluud rotate` — rotate the project token (owner only).
 */

import { requireIdentity } from "../lib/identity.js";
import { saveProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import type { Command, CommandContext } from "./index.js";

export const rotateCommand: Command = {
  name: "rotate",
  description: "Rotate the project token (owner only)",

  async run(ctx: CommandContext): Promise<number> {
    if (!ctx.api.isAuthenticated) {
      throw new CliError("Not signed in. Run `bluud login`.", { code: "auth_required" });
    }

    const identity = await requireIdentity(ctx.cwd);
    const token = await ctx.api.rotateProjectToken(identity.projectId);
    await saveProjectToken(identity.projectId, token);
    ctx.out.writeLine("Project token rotated. Collaborators must run `bluud sync` to update.");
    return 0;
  },
};
