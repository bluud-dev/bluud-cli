/**
 * Persistent configuration and credential storage under `~/.bluud/`.
 *
 * The layout matches `BLUUD_CONCEPT.md` §6.2:
 *   ~/.bluud/auth.json                — session tokens (or PAT placeholder)
 *   ~/.bluud/projects/<id>/token      — per-project shared token
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

import { CliError } from "./error.js";
import type { AuthSession } from "../types.js";

const CONFIG_DIR_NAME = ".bluud";

/**
 * Absolute path to Bluud's config directory.
 *
 * The concept (§6.2, §15) fixes this at `~/.bluud` — deliberately NOT under
 * `$XDG_CONFIG_HOME`, so the token layout `~/.bluud/projects/<id>/token` is
 * stable and identical across machines and platforms. `BLUUD_CONFIG_DIR`
 * overrides the location outright (used for hermetic tests and power users),
 * mirroring the env-override pattern of the reference tools (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, …).
 */
export function getConfigDir(): string {
  const override = process.env.BLUUD_CONFIG_DIR?.trim();
  if (override) {
    return override;
  }
  return join(os.homedir(), CONFIG_DIR_NAME);
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}

export function getProjectTokenPath(projectId: string): string {
  return join(getConfigDir(), "projects", projectId, "token");
}

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  /** When true, access_token is a PAT and refresh_token is unused. */
  isPat?: boolean;
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
}

export async function saveAuth(session: AuthSession, isPat = false): Promise<void> {
  await ensureConfigDir();
  const stored: StoredAuth = { ...session, isPat };
  await writeFile(getAuthPath(), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

export async function loadAuth(): Promise<StoredAuth | null> {
  try {
    const raw = await readFile(getAuthPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed.access_token || typeof parsed.access_token !== "string") {
      return null;
    }
    return parsed;
  } catch (err) {
    if (isMissingError(err)) {
      return null;
    }
    throw new CliError("Failed to read auth configuration", {
      code: "config_error",
      cause: err,
    });
  }
}

export async function clearAuth(): Promise<void> {
  try {
    await rm(getAuthPath(), { force: true });
  } catch (err) {
    if (!isMissingError(err)) {
      throw new CliError("Failed to remove auth configuration", {
        code: "config_error",
        cause: err,
      });
    }
  }
}

export async function saveProjectToken(projectId: string, token: string): Promise<void> {
  const dir = join(getConfigDir(), "projects", projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "token"), token, { mode: 0o600 });
}

export async function loadProjectToken(projectId: string): Promise<string | null> {
  try {
    return await readFile(getProjectTokenPath(projectId), "utf8");
  } catch (err) {
    if (isMissingError(err)) {
      return null;
    }
    throw new CliError(`Failed to read project token for ${projectId}`, {
      code: "config_error",
      cause: err,
    });
  }
}

export async function clearProjectToken(projectId: string): Promise<void> {
  try {
    await rm(getProjectTokenPath(projectId), { force: true });
  } catch (err) {
    if (!isMissingError(err)) {
      throw new CliError(`Failed to remove project token for ${projectId}`, {
        code: "config_error",
        cause: err,
      });
    }
  }
}

function isMissingError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === "EISDIR")
  );
}
