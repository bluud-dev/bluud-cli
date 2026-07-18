/**
 * Registry of hook-capable AI tool adapters.
 *
 * Each adapter implements the gortex-style Detect → Plan → Apply contract.
 * Tools that do not support lifecycle hooks are handled by the `skills` CLI
 * instruction-only delivery and do not appear here.
 */

import { claudeCodeAdapter } from "./claudecode.js";
import { codexAdapter } from "./codex.js";
import { geminiCliAdapter } from "./geminicli.js";
import { antigravityAdapter } from "./antigravity.js";
import { kimiAdapter } from "./kimi.js";
import { clineAdapter } from "./cline.js";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter, uninstallClaudeCode } from "./claudecode.js";
export { codexAdapter, uninstallCodex } from "./codex.js";
export { geminiCliAdapter, uninstallGeminiCli } from "./geminicli.js";
export { antigravityAdapter, uninstallAntigravity } from "./antigravity.js";
export { kimiAdapter, uninstallKimi } from "./kimi.js";
export { clineAdapter, uninstallCline } from "./cline.js";

export const adapters: Adapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  geminiCliAdapter,
  antigravityAdapter,
  kimiAdapter,
  clineAdapter,
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
