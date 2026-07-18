/**
 * Registry of hook-capable AI tool adapters.
 *
 * Each adapter implements the gortex-style Detect → Plan → Apply contract.
 * Tools that do not support lifecycle hooks are handled by the `skills` CLI
 * instruction-only delivery and do not appear here.
 */

import { claudeCodeAdapter } from "./claudecode.js";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter } from "./claudecode.js";

export const adapters: Adapter[] = [claudeCodeAdapter];

export async function planAll(env: AdapterEnv): Promise<AdapterPlan[]> {
  return Promise.all(adapters.map((adapter) => adapter.plan(env)));
}

export async function applyAll(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult[]> {
  return Promise.all(adapters.map((adapter) => adapter.apply(env, opts)));
}

export function adapterNames(): string[] {
  return adapters.map((a) => a.name);
}
