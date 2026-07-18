/**
 * `bluud logout` — remove stored session credentials.
 *
 * Revokes the session's refresh token server-side when one exists, then clears
 * local auth.json. The local clear happens even if the revocation call fails,
 * so the user is never left with undeletable credentials.
 */

import { clearAuth, loadAuth } from "../lib/config.js";
import type { Command } from "./index.js";

export const logoutCommand: Command = {
  name: "logout",
  description: "Remove stored session credentials",

  async run(ctx): Promise<number> {
    const auth = await loadAuth();
    if (auth && auth.refresh_token && !auth.isPat) {
      try {
        await ctx.api.logout(auth.refresh_token);
      } catch {
        ctx.log.warn(
          "Could not revoke the session server-side; local credentials will still be cleared.",
        );
      }
    }

    await clearAuth();
    ctx.out.writeLine("Signed out.");
    return 0;
  },
};
