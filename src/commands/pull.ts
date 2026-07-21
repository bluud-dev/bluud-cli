/**
 * `bluud pull` — fetch memory for the current project.
 *
 * Used by the skill/hook at session start. `--inject` prints memory in a form
 * suitable for loading into agent context: `--index` for the lightweight
 * index (default skill-mode reading), `--id` (repeatable) to load specific
 * nodes' full content by id, or neither for the full-tree dump. Hooks always
 * use plain `--inject` (optionally with `--format`) — index/id are a
 * skill-mode-only addition and never combine with `--format`.
 */

import { requireIdentity } from "../lib/identity.js";
import { loadProjectToken } from "../lib/config.js";
import { CliError } from "../lib/error.js";
import { getFlagBoolean, getFlagString, getFlagArray } from "../lib/args.js";
import {
  formatQuotaWarning,
  isQuotaWarning,
  renderClineHookOutput,
  renderGeminiHookOutput,
  renderMemoryIndex,
  renderMemoryNodes,
  renderMemoryTree,
} from "../lib/memory.js";
import type { Command, CommandContext } from "./index.js";

const HOOK_FORMATS = new Set(["gemini", "cline"]);

export const pullCommand: Command = {
  name: "pull",
  description: "Fetch memory for the current project",

  async run(ctx: CommandContext): Promise<number> {
    const identity = await requireIdentity(ctx.cwd);
    const projectToken = await loadProjectToken(identity.projectId);
    if (projectToken === null) {
      throw new CliError(
        `No project token found for ${identity.projectId}. Run \`bluud\` to set up this directory.`,
        { code: "auth_required" },
      );
    }

    const tree = await ctx.api.pullMemory(identity.projectId, projectToken);

    if (isQuotaWarning(tree)) {
      ctx.log.warn(formatQuotaWarning(tree));
    }

    if (getFlagBoolean(ctx.flags, "json")) {
      ctx.out.writeLine(JSON.stringify(tree, null, 2));
      return 0;
    }

    if (getFlagBoolean(ctx.flags, "inject")) {
      const format = getFlagString(ctx.flags, "format");
      if (format !== undefined && !HOOK_FORMATS.has(format)) {
        throw new CliError(
          `Unknown --format '${format}'. Expected one of: ${Array.from(HOOK_FORMATS).join(", ")}.`,
          { code: "config_error" },
        );
      }

      const index = getFlagBoolean(ctx.flags, "index");
      const ids = getFlagArray(ctx.flags, "id");

      if (index && ids.length > 0) {
        throw new CliError("--index and --id cannot be combined; pick one.", {
          code: "config_error",
        });
      }
      if ((index || ids.length > 0) && format !== undefined) {
        throw new CliError("--index/--id and --format cannot be combined; pick one.", {
          code: "config_error",
        });
      }

      if (index) {
        ctx.out.writeLine(renderMemoryIndex(tree));
      } else if (ids.length > 0) {
        ctx.out.writeLine(renderMemoryNodes(tree, ids));
      } else if (format === "gemini") {
        ctx.out.writeLine(renderGeminiHookOutput(tree));
      } else if (format === "cline") {
        ctx.out.writeLine(renderClineHookOutput(tree));
      } else {
        ctx.out.writeLine(renderMemoryTree(tree));
      }
      return 0;
    }

    ctx.out.writeLine(`Pulled ${tree.nodes.length} node(s), ${tree.total_size_bytes} bytes.`);

    return 0;
  },
};
