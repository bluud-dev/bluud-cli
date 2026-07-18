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
import { validateDiffOperations } from "../lib/memory.js";
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

    const raw = await readStdin(ctx.stdin ?? stdin);
    let operations: DiffOperation[];
    try {
      const parsed = JSON.parse(raw);
      operations = validateDiffOperations(parsed);
    } catch (err) {
      const message = err instanceof CliError ? err.message : "Push payload must be valid JSON.";
      throw new CliError(message, {
        code: "api_error",
        cause: err instanceof CliError ? undefined : err,
      });
    }

    try {
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
    } catch (err) {
      // 423 Locked means the project is already read-only; surface a clear
      // warning to the agent/user without failing the session.
      if (err instanceof CliError && err.code === "project_locked") {
        ctx.out.writeLine(
          formatWarning(
            "Project memory is read-only (storage quota exceeded). Pulls continue to work; reduce usage or upgrade to push again.",
          ),
        );
        return 0;
      }
      throw err;
    }
  },
};

function readStdin(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", (err) => reject(err));
  });
}
