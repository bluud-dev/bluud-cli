/**
 * `bluud pull` — fetch memory for the current project.
 *
 * Used by the skill/hook at session start. `--inject` prints memory in a form
 * suitable for loading into agent context: `--index` for the lightweight
 * index (the default for every hook, and for skill-mode reading), `--id`
 * (repeatable) to load specific nodes' full content by id, or neither for the
 * full-tree dump. `--format` (gemini/cline) is an independent axis — it
 * selects the hook envelope a tool's contract requires and wraps whichever
 * content `--index`/`--id`/neither selected; every hook-capable tool's
 * generated hook script passes `--index` (see `src/hooks/bluud-pull-hook.sh`),
 * combined with `--format` for the tools that need an envelope.
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

      // Content selection (index / selected nodes / full tree) and envelope
      // format (plain / gemini / cline) are independent axes: every
      // hook-capable tool's hook now requests `--index`, and hook envelopes
      // must be able to wrap it exactly like they wrap the full tree.
      const content = index
        ? renderMemoryIndex(tree)
        : ids.length > 0
          ? renderMemoryNodes(tree, ids)
          : renderMemoryTree(tree);

      if (format === "gemini") {
        ctx.out.writeLine(renderGeminiHookOutput(content));
      } else if (format === "cline") {
        ctx.out.writeLine(renderClineHookOutput(content));
      } else {
        ctx.out.writeLine(content);
      }
      return 0;
    }

    ctx.out.writeLine(`Pulled ${tree.nodes.length} node(s), ${tree.total_size_bytes} bytes.`);

    return 0;
  },
};
