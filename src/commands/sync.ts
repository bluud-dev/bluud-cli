/**
 * `bluud sync` — re-fetch the active project token for the current directory.
 */

import { requireIdentity } from "../lib/identity.js";
import { saveProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import type { Command, CommandContext } from "./index.js";

export const syncCommand: Command = {
  name: "sync",
  description: "Re-fetch the active project token",

  async run(ctx: CommandContext): Promise<number> {
    if (!ctx.api.isAuthenticated) {
      throw new CliError("Not signed in. Run `bluud login`.", { code: "auth_required" });
    }

    const identity = await requireIdentity(ctx.cwd);
    const token = await ctx.api.syncProjectToken(identity.projectId);
    await saveProjectToken(identity.projectId, token);
    ctx.out.writeLine("Project token synced.");
    return 0;
  },
};
