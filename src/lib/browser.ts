/**
 * Cross-platform browser opener.
 *
 * Used by the PKCE loopback login flow to open the Bluud web consent screen.
 * Falls back gracefully when no browser can be launched (SSH, containers).
 */

import { spawn } from "node:child_process";
import process from "node:process";

const platformCommands: Record<string, string[]> = {
  darwin: ["open"],
  win32: ["cmd", "/c", "start"],
  linux: ["xdg-open"],
};

export async function openBrowser(url: string): Promise<boolean> {
  if (process.env.BLUUD_NO_BROWSER === "1" || process.env.CI) {
    return false;
  }

  const commands = platformCommands[process.platform];
  if (!commands) {
    return false;
  }

  return new Promise((resolve) => {
    const child = spawn(commands[0], [...commands.slice(1), url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));

    // If the process has not exited after a short delay, assume it opened.
    setTimeout(() => resolve(true), 500);
  });
}
