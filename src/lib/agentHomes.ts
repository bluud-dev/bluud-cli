/**
 * Where each AI tool keeps its user-level configuration.
 *
 * Two independent concerns need these paths and must never disagree about
 * them: `detect.ts` probes them to decide whether a tool is installed, and the
 * skill-target registry in `skills.ts` derives each tool's global skills
 * directory from them. A tool whose config lives somewhere non-standard would
 * otherwise be *detected* at the relocated path but have its skill *written*
 * to the stock one, where the tool never looks — a silent no-op install.
 *
 * They live in their own module rather than in either caller because
 * `detect.ts` already imports from `skills.ts`; putting them in `skills.ts`
 * would work but makes the dependency of detection on the installer look
 * load-bearing when it is only a shared constant.
 *
 * Each override is the variable the tool itself documents, matching how the
 * `skills` registry resolves the same directories (`skills/src/agents.ts`).
 */

import { join } from "node:path";
import os from "node:os";

/** Home directory Claude Code reads its config from (`CLAUDE_CONFIG_DIR`). */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(os.homedir(), ".claude");
}

/** Home directory Codex reads its config from (`CODEX_HOME`). */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(os.homedir(), ".codex");
}
