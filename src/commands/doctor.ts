/**
 * `bluud doctor` — show what is configured per tool without writing.
 */

import pc from "picocolors";
import os from "node:os";
import { requireIdentity } from "../lib/identity.js";
import { loadProjectToken } from "../lib/config.js";
import { planAll } from "../lib/adapters/index.js";
import type { AdapterEnv } from "../lib/adapters/types.js";
import { getFlagBoolean } from "../lib/args.js";

import type { Command, CommandContext } from "./index.js";

export const doctorCommand: Command = {
  name: "doctor",
  description: "Show what is configured per tool without writing",

  async run(ctx: CommandContext): Promise<number> {
    const identity = await requireIdentity(ctx.cwd);
    const projectToken = await loadProjectToken(identity.projectId);
    const env = buildEnv(ctx);
    const plans = await planAll(env);

    if (getFlagBoolean(ctx.flags, "json")) {
      ctx.out.writeLine(
        JSON.stringify(
          {
            identity,
            token_present: projectToken !== null,
            plans: plans.map((p) => ({
              name: p.name,
              detected: p.detected,
              actions: p.actions,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    ctx.out.writeLine(`${pc.bold("Project identity")}`);
    ctx.out.writeLine(`  id:     ${identity.projectId}`);
    ctx.out.writeLine(`  source: ${identity.identitySource}`);
    ctx.out.writeLine(`  token:  ${projectToken !== null ? "present" : "missing"}`);
    ctx.out.writeLine("");
    ctx.out.writeLine(`${pc.bold("Hook adapters")}`);
    for (const plan of plans) {
      ctx.out.writeLine(`  ${plan.detected ? pc.green("●") : pc.gray("○")} ${plan.name}`);
      for (const action of plan.actions) {
        const icon = action.wouldChange
          ? pc.yellow("~")
          : action.present
            ? pc.green("✓")
            : pc.gray("-");
        ctx.out.writeLine(`    ${icon} ${action.description}`);
      }
    }

    return 0;
  },
};

function buildEnv(ctx: CommandContext): AdapterEnv {
  return {
    cwd: ctx.cwd,
    home: os.homedir(),
    global: false,
    bluudBinary: process.argv[1] ?? "bluud",
  };
}
