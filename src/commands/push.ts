/**
 * `bluud push` — push a memory diff for the current project.
 *
 * Reads a JSON diff from stdin.  The skill pipes the diff produced by the
 * agent into this command.
 */

import { stdin } from "node:process";
import { requireIdentity } from "../lib/identity.js";
import { loadProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import { formatWarning } from "../lib/output.js";
import { getFlagBoolean } from "../lib/args.js";
import type { Command, CommandContext } from "./index.js";
import type { DiffOperation } from "../types.js";

export const pushCommand: Command = {
  name: "push",
  description: "Push a memory diff for the current project",

  async run(ctx: CommandContext): Promise<number> {
    const identity = await requireIdentity(ctx.cwd);
    const projectToken = await loadProjectToken(identity.projectId);
    if (projectToken === null) {
      throw new CliError(
        `No project token found for ${identity.projectId}. Run \`bluud\` to set up this directory.`,
        { code: "auth_required" },
      );
    }

    const raw = await readStdin();
    let operations: DiffOperation[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.operations)) {
        throw new Error("Missing 'operations' array");
      }
      operations = parsed.operations;
    } catch (err) {
      throw new CliError(
        "Push payload must be valid JSON with an 'operations' array. Pipe from the skill or agent.",
        { code: "api_error", cause: err },
      );
    }

    const result = await ctx.api.pushMemory(identity.projectId, projectToken, operations);

    if (getFlagBoolean(ctx.flags, "json")) {
      ctx.out.writeLine(JSON.stringify(result, null, 2));
      return 0;
    }

    ctx.out.writeLine(
      `Pushed ${operations.length} operation(s). Total size: ${result.total_size_bytes} bytes.`,
    );
    if (result.read_only) {
      ctx.out.writeLine(
        formatWarning(
          "This push exceeded the quota. The project is now read-only until usage drops or the subscription is upgraded.",
        ),
      );
    }
    return 0;
  },
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", (err) => reject(err));
  });
}
