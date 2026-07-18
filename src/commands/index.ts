/**
 * Command registry and shared context.
 */

import type { ApiClient } from "../lib/api.js";
import type { Output } from "../lib/output.js";
import type { Logger } from "../lib/logger.js";

export interface CommandContext {
  api: ApiClient;
  out: Output;
  /** Leveled diagnostics (stderr). Distinct from `out`, which is program data. */
  log: Logger;
  cwd: string;
  args: string[];
  flags: Record<string, string | boolean | string[]>;
  /** When true, the CLI is running non-interactively (e.g. inside an agent). */
  nonInteractive: boolean;
}

export interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext): Promise<number>;
}
