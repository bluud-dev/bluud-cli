/**
 * Gortex-style adapter contract for writing real lifecycle hooks into the
 * subset of AI tools that support them.
 */

export interface AdapterEnv {
  /** Absolute path to the current project directory. */
  cwd: string;
  /** Absolute path to the user's home directory. */
  home: string;
  /** True when running in global (per-machine) install mode. */
  global: boolean;
  /** Resolved absolute path to the `bluud` binary. */
  bluudBinary: string;
}

export interface FileAction {
  path: string;
  description: string;
  present: boolean;
  wouldChange: boolean;
}

export interface AdapterPlan {
  name: string;
  detected: boolean;
  actions: FileAction[];
}

export interface ApplyOptions {
  dryRun: boolean;
  force: boolean;
}

export interface AdapterResult {
  name: string;
  applied: boolean;
  actions: FileAction[];
}

export interface Adapter {
  name: string;
  detect(env: AdapterEnv): Promise<boolean>;
  plan(env: AdapterEnv): Promise<AdapterPlan>;
  apply(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult>;
}
