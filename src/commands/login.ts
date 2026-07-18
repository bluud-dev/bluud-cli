/**
 * `bluud login` — authenticate this machine.
 *
 * Primary flow: browser loopback with PKCE.
 * Fallback flow: paste a personal access token with `--token <PAT>`.
 */

import * as p from "@clack/prompts";
import { loginWithBrowser, loginWithToken } from "../lib/auth.js";
import { saveAuth } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import { getFlagString } from "../lib/args.js";
import type { Command, CommandContext } from "./index.js";

export const loginCommand: Command = {
  name: "login",
  description: "Authenticate this machine",

  async run(ctx: CommandContext): Promise<number> {
    const tokenFlag = getFlagString(ctx.flags, "token");

    if (tokenFlag) {
      const session = await loginWithToken(ctx.api, tokenFlag);
      await saveAuth(session, true);
      ctx.out.writeLine("Authenticated with personal access token.");
      return 0;
    }

    if (ctx.nonInteractive) {
      throw new CliError(
        "Non-interactive login requires --token <PAT>. Generate one at https://bluud.dev/settings/tokens",
        { code: "auth_failed" },
      );
    }

    const method = await p.select({
      message: "How would you like to sign in?",
      options: [
        { value: "browser", label: "Browser (recommended)" },
        { value: "token", label: "Paste a personal access token" },
      ],
    });

    if (p.isCancel(method)) {
      throw new CliError("Login cancelled.", { code: "cancelled" });
    }

    if (method === "token") {
      const pat = await p.password({
        message: "Paste your personal access token from https://bluud.dev/settings/tokens",
      });
      if (p.isCancel(pat)) {
        throw new CliError("Login cancelled.", { code: "cancelled" });
      }
      const session = await loginWithToken(ctx.api, pat);
      await saveAuth(session, true);
      ctx.out.writeLine("Authenticated with personal access token.");
      return 0;
    }

    const spinner = p.spinner();
    spinner.start("Waiting for browser authorization…");
    try {
      const session = await loginWithBrowser(ctx.api);
      await saveAuth(session, false);
      spinner.stop("Signed in.");
      ctx.out.writeLine("Authenticated successfully.");
      return 0;
    } catch (err) {
      spinner.stop("Authorization failed.");
      throw err;
    }
  },
};
