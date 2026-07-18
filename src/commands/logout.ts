/**
 * `bluud logout` — remove stored session credentials.
 */

import { clearAuth } from "../lib/config.js";
import type { Command } from "./index.js";

export const logoutCommand: Command = {
  name: "logout",
  description: "Remove stored session credentials",

  async run(): Promise<number> {
    await clearAuth();
    return 0;
  },
};
