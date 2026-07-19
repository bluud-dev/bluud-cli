/**
 * Main entry point for the Bluud CLI.
 *
 * Dispatches to command modules and handles top-level error formatting.
 */

import process from "node:process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { parseArgs, getFlagBoolean } from "./lib/args.js";
import { ApiClient } from "./lib/api.js";
import { loadAuth, saveAuth } from "./lib/config.js";
import { CliError, guidanceForCode, type ErrorCode } from "./lib/error.js";
import { createLogger, resolveLogLevel } from "./lib/logger.js";
import { defaultOutput, formatError } from "./lib/output.js";
import type { CommandContext } from "./commands/index.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { statusCommand } from "./commands/status.js";
import { pullCommand } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { syncCommand } from "./commands/sync.js";
import { rotateCommand } from "./commands/rotate.js";
import { relinkCommand } from "./commands/relink.js";
import { reassignCommand } from "./commands/reassign.js";
import { doctorCommand } from "./commands/doctor.js";
import { installCommand } from "./commands/install.js";
import { uninstallCommand } from "./commands/uninstall.js";

const commands = [
  loginCommand,
  logoutCommand,
  statusCommand,
  pullCommand,
  pushCommand,
  syncCommand,
  rotateCommand,
  relinkCommand,
  reassignCommand,
  doctorCommand,
  installCommand,
  uninstallCommand,
];

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  const nonInteractive = Boolean(
    process.env.BLUUD_NON_INTERACTIVE ||
    process.env.CI ||
    getFlagBoolean(flags, "yes") ||
    getFlagBoolean(flags, "y"),
  );

  if (getFlagBoolean(flags, "version") || getFlagBoolean(flags, "v")) {
    process.stdout.write(`${await getVersion()}\n`);
    return 0;
  }

  if (getFlagBoolean(flags, "help") || getFlagBoolean(flags, "h") || command === "help") {
    printHelp();
    return 0;
  }

  const log = createLogger({
    level: resolveLogLevel({
      quiet: getFlagBoolean(flags, "quiet") || getFlagBoolean(flags, "q"),
      verbose: getFlagBoolean(flags, "verbose") || getFlagBoolean(flags, "V"),
      debug: getFlagBoolean(flags, "debug"),
      env: process.env.BLUUD_LOG,
    }),
  });

  // Persist a silently-refreshed session so the rotated pair survives the
  // process. A PAT session never refreshes (empty refresh token), so this only
  // ever writes a real browser-login session — isPat stays false correctly.
  const api = new ApiClient({
    onSessionRefreshed: async (session) => {
      await saveAuth(session, false);
      log.debug("Session token refreshed and persisted.");
    },
  });
  const auth = await loadAuth();
  if (auth) {
    api.setSession(auth);
  }

  const ctx: CommandContext = {
    api,
    out: defaultOutput,
    log,
    cwd: process.cwd(),
    args: positionals,
    flags,
    nonInteractive,
  };

  const target = command === null ? installCommand : commands.find((c) => c.name === command);

  if (!target) {
    defaultOutput.errorLine(formatError(`Unknown command: ${command ?? ""}`));
    printHelp();
    return 1;
  }

  return target.run(ctx);
}

function printHelp(): void {
  const lines = [
    `${pc.bold("Bluud")} — agent memory for this project`,
    "",
    "Usage: bluud [command] [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${pc.cyan(c.name.padEnd(12))} ${c.description}`),
    "",
    "Options:",
    `  ${pc.cyan("-y, --yes")}            Accept all prompts (non-interactive)`,
    `  ${pc.cyan("-a, --agent <name>")}   Constrain to specific tool(s) (repeatable)`,
    `  ${pc.cyan("--agents-skip <name>")} Exclude specific tool(s) (repeatable)`,
    `  ${pc.cyan("-g, --global")}         Install to user-level dirs instead of the project`,
    `  ${pc.cyan("--copy")}               Force copy instead of symlink`,
    `  ${pc.cyan("--token <PAT>")}        Non-interactive auth with a personal access token`,
    `  ${pc.cyan("--dry-run")}            Show what would change without writing`,
    `  ${pc.cyan("--json")}               Machine-readable output`,
    `  ${pc.cyan("--force")}              Overwrite merge-preserved keys`,
    `  ${pc.cyan("-V, --verbose")}        Verbose diagnostics (debug logging)`,
    `  ${pc.cyan("-q, --quiet")}          Only show errors`,
    `  ${pc.cyan("-v, --version")}        Show version`,
    `  ${pc.cyan("-h, --help")}           Show this help`,
  ];
  defaultOutput.writeLine(lines.join("\n"));
}

async function getVersion(): Promise<string> {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(modulePath), "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof CliError) {
      // A user-initiated cancel (Ctrl-C at a prompt) is not an error to shout
      // about — exit quietly with a non-zero code.
      if (err.code === "cancelled") {
        defaultOutput.errorLine("Cancelled.");
        process.exit(err.exitCode);
      }
      defaultOutput.errorLine(formatError(err.message));
      const guidance = guidanceForCode(err.code as ErrorCode);
      if (guidance) {
        defaultOutput.errorLine(pc.dim(guidance));
      }
      process.exit(err.exitCode);
    }
    defaultOutput.errorLine(formatError(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
