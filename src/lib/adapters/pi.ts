/**
 * Pi hook adapter (earendil-works/pi, a.k.a. pi-mono).
 *
 * Pi is the one hook-capable tool with no hooks section in any config file —
 * by design. Its documented integration surface is an **extension module**: a
 * TypeScript file under `.pi/extensions/<name>/index.ts` whose default export
 * receives the agent object and subscribes to lifecycle events. There is no
 * settings key to merge and no command string to register, so for Pi
 * "installing a hook" means writing one file, and this adapter is a file
 * writer rather than a config merger.
 *
 * That single difference is why this does not reuse `hookScript.ts`'s
 * materialize-a-shell-script machinery. That machinery exists to solve a
 * problem Pi does not have: a tool's config storing a volatile `bluud` path
 * that goes stale under `npx`. Pi's config stores nothing — the extension
 * carries the path in its own body, and every `bluud` run rewrites the
 * extension, so the path self-heals by exactly the same mechanism, one layer
 * up. Adding a shell script between Pi and `bluud` would buy nothing and cost
 * a process spawn per session.
 *
 * What *is* shared is the ownership convention: the extension carries the
 * `bluud:managed` marker, and a file at that path without the marker is
 * treated as user-authored and never overwritten or removed. That is the same
 * file-level contract `hookScript.ts` applies, enforced here with the same
 * `isManagedByBluud` predicate rather than a parallel copy of the rule.
 *
 * Which lifecycle events the extension subscribes to, and why it takes three
 * of them to inject once, is documented in the template itself
 * (`src/hooks/bluud-pi-extension.ts`).
 *
 * File layout:
 *   project: <cwd>/.pi/extensions/bluud/index.ts
 *   global:  <home>/.pi/agent/extensions/bluud/index.ts
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, rm, rmdir } from "node:fs/promises";
import { bundledHooksPath } from "../skills.js";
import type { Adapter, AdapterEnv, AdapterPlan, AdapterResult, ApplyOptions } from "./types.js";
import { atomicWriteFile, readTextFile } from "./writer.js";
import { isManagedByBluud } from "./hookScript.js";

const ADAPTER_NAME = "pi";

/** The directory Bluud owns inside Pi's extensions tree. */
const EXTENSION_DIR_NAME = "bluud";

/** Template shipped in the package; see the module header. */
const TEMPLATE_FILE_NAME = "bluud-pi-extension.ts";

/**
 * Placeholder the template carries in place of the resolved `bluud` path.
 *
 * It is substituted with a **JSON literal**, not a bare string, and the
 * template writes it unquoted (`const BLUUD_BINARY: string = @BLUUD_BINARY@;`).
 * That is what makes a Windows path safe here without any escaping rules of
 * Bluud's own: `JSON.stringify` is already the exact escaping TypeScript string
 * literals use, so `C:\Users\me\bluud` round-trips intact where a naive
 * quote-wrapping substitution would emit `"C:\Users\me\bluud"` and have the
 * `\U` read as an invalid escape.
 */
const BINARY_PLACEHOLDER = "@BLUUD_BINARY@";

export const piAdapter: Adapter = {
  name: ADAPTER_NAME,

  async detect(env: AdapterEnv): Promise<boolean> {
    // A project-local `.pi/` is the strongest signal in project mode; a
    // user-level `~/.pi` covers both modes. Either is enough.
    if (!env.global && existsSync(join(env.cwd, ".pi"))) return true;
    return existsSync(join(env.home, ".pi"));
  },

  async plan(env: AdapterEnv): Promise<AdapterPlan> {
    const path = extensionPath(env);
    const detected = await this.detect(env);
    const existing = await readTextFile(path);
    const foreign = existing !== null && !isManagedByBluud(existing);

    let wouldChange = false;
    if (detected && !foreign) {
      const desired = await renderExtension(env);
      wouldChange = desired !== null && desired !== existing;
    }

    return {
      name: ADAPTER_NAME,
      detected,
      actions: [
        {
          path,
          description: foreign
            ? "Bluud memory extension (skipped — an existing user-authored extension is present)"
            : "Bluud memory extension (session_start / before_agent_start / context)",
          present: existing !== null,
          wouldChange,
        },
      ],
    };
  },

  async apply(env: AdapterEnv, opts: ApplyOptions): Promise<AdapterResult> {
    const plan = await this.plan(env);
    if (!plan.detected || opts.dryRun) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const path = extensionPath(env);
    const existing = await readTextFile(path);
    if (existing !== null && !isManagedByBluud(existing)) {
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    const desired = await renderExtension(env);
    if (desired === null) {
      // An unreadable template is nothing this adapter can legitimately write.
      return { name: ADAPTER_NAME, applied: false, actions: plan.actions };
    }

    // Skip an identical rewrite so the file's mtime does not churn on every
    // `bluud` run — Pi watches its extensions directory.
    if (existing !== desired) {
      await atomicWriteFile(path, desired);
    }

    return { name: ADAPTER_NAME, applied: true, actions: plan.actions };
  },
};

/**
 * Pi's extension roots differ between scopes by more than a prefix: the global
 * one nests under an `agent/` segment. Both are taken from Pi's own extensions
 * documentation rather than inferred from the project layout.
 */
function extensionDir(env: AdapterEnv): string {
  return env.global
    ? join(env.home, ".pi", "agent", "extensions", EXTENSION_DIR_NAME)
    : join(env.cwd, ".pi", "extensions", EXTENSION_DIR_NAME);
}

function extensionPath(env: AdapterEnv): string {
  return join(extensionDir(env), "index.ts");
}

/**
 * Fill the template, or `null` when it cannot be read or the binary path
 * cannot be represented.
 *
 * Returning `null` instead of throwing keeps `plan` total — `bluud doctor`
 * runs over every tool, so one unreadable asset must degrade to "nothing to
 * change here" rather than abort the whole readout.
 */
async function renderExtension(env: AdapterEnv): Promise<string | null> {
  let template: string;
  try {
    template = await readFile(join(bundledHooksPath(), TEMPLATE_FILE_NAME), "utf8");
  } catch {
    return null;
  }

  const literal = JSON.stringify(env.bluudBinary);
  // `JSON.stringify` escapes quotes, backslashes, and control characters, so
  // the only value it cannot render safely is one that is not a string.
  if (typeof env.bluudBinary !== "string" || env.bluudBinary.length === 0) return null;

  // The extension is TypeScript consumed by Pi's own loader on every platform;
  // LF is correct everywhere and CRLF would survive into a published package
  // through `core.autocrlf`. Normalize rather than trust what reached disk.
  return template.split(BINARY_PLACEHOLDER).join(literal).replace(/\r\n/g, "\n");
}

export async function uninstallPi(env: AdapterEnv): Promise<boolean> {
  const path = extensionPath(env);
  const existing = await readTextFile(path);
  if (existing === null || !isManagedByBluud(existing)) return false;

  await rm(path, { force: true });

  // Remove Bluud's own extension directory once empty, so an uninstall leaves
  // no orphaned `extensions/bluud/` behind. `rmdir` succeeds only on an empty
  // directory, so a user file inside it keeps both the directory and the file.
  await rmdir(extensionDir(env)).catch(() => undefined);

  return true;
}
