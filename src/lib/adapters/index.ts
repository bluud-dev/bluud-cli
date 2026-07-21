/**
 * Registry of hook-capable AI tool adapters.
 *
 * Each adapter implements the gortex-style Detect → Plan → Apply contract.
 * Tools that do not support lifecycle hooks at all are handled by the `skills`
 * CLI instruction-only delivery and do not appear here.
 *
 * "Hook-capable" does not mean "shaped like Claude Code". These nine tools
 * agree on the contract above and on almost nothing else, so each adapter
 * implements its tool's own hook architecture rather than a shared abstraction
 * over them. The mechanisms actually in use here are:
 *
 *   - a JSON settings merge, stdout becoming context — claude-code, gemini-cli,
 *     antigravity, kimi-code-cli
 *   - a TOML settings merge — codex
 *   - a standalone executable file whose *name* is the event — cline
 *   - a YAML settings merge on a per-turn event, narrowed to once-per-session
 *     by reading the tool's own hook payload — hermes-agent
 *   - a TypeScript extension module subscribing to lifecycle events, because
 *     the tool has no hooks config at all — pi
 *   - declarative prompt documents, because the tool's hooks cannot execute a
 *     command — kiro-cli
 *
 * The differences are load-bearing. Collapsing any of the last three onto the
 * first would produce an integration that silently does nothing.
 */

import { claudeCodeAdapter } from "./claudecode.js";
import { codexAdapter } from "./codex.js";
import { geminiCliAdapter } from "./geminicli.js";
import { antigravityAdapter } from "./antigravity.js";
import { kimiAdapter } from "./kimi.js";
import { clineAdapter } from "./cline.js";
import { hermesAdapter } from "./hermes.js";
import { piAdapter } from "./pi.js";
import { kiroAdapter } from "./kiro.js";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter, uninstallClaudeCode } from "./claudecode.js";
export { codexAdapter, uninstallCodex } from "./codex.js";
export { geminiCliAdapter, uninstallGeminiCli } from "./geminicli.js";
export { antigravityAdapter, uninstallAntigravity } from "./antigravity.js";
export { kimiAdapter, uninstallKimi } from "./kimi.js";
export { clineAdapter, uninstallCline } from "./cline.js";
export { hermesAdapter, uninstallHermes } from "./hermes.js";
export { piAdapter, uninstallPi } from "./pi.js";
export { kiroAdapter, uninstallKiro } from "./kiro.js";

export const adapters: Adapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  geminiCliAdapter,
  antigravityAdapter,
  kimiAdapter,
  clineAdapter,
  hermesAdapter,
  piAdapter,
  kiroAdapter,
];

export async function planAll(env: AdapterEnv): Promise<AdapterPlan[]> {
  return Promise.all(adapters.map((adapter) => adapter.plan(env)));
}

export async function applyAll(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult[]> {
  return Promise.all(adapters.map((adapter) => adapter.apply(env, opts)));
}

export function adapterNames(): string[] {
  return adapters.map((a) => a.name);
}
