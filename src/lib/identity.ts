/**
 * Project identity computation.
 *
 * Mirrors `backend/app/services/identity.py` exactly:
 *   1. If a git remote origin URL exists, SHA-256 its canonical form.
 *   2. Otherwise, SHA-256 the absolute directory path.
 * The hex digest is truncated to 32 characters.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { simpleGit } from "simple-git";
import { CliError } from "./error.js";
import type { ProjectIdentity } from "../types.js";

export async function computeIdentity(cwd: string): Promise<ProjectIdentity> {
  const absolutePath = resolve(cwd);
  const gitRemote = await getGitRemoteOrigin(absolutePath);

  if (gitRemote !== null) {
    const normalized = normalizeGitRemote(gitRemote);
    return {
      projectId: sha256HexFirst32(normalized),
      identitySource: "git_remote",
      gitRemote: normalized,
      path: absolutePath,
    };
  }

  return {
    projectId: sha256HexFirst32(normalizePath(absolutePath)),
    identitySource: "path_hash",
    gitRemote: null,
    path: absolutePath,
  };
}

async function getGitRemoteOrigin(absolutePath: string): Promise<string | null> {
  try {
    const git = simpleGit(absolutePath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    return origin?.refs.fetch ?? origin?.refs.push ?? null;
  } catch {
    return null;
  }
}

export function normalizeGitRemote(url: string): string {
  let normalized = url.trim().toLowerCase();

  // Strip embedded credentials.
  normalized = normalized.replace(/(https?|git|ssh):\/\/[^@]+@/, (match) => {
    return match.split("@", 2)[1] ?? match;
  });

  // Strip explicit schemes.
  normalized = normalized.replace(/^https?:\/\//, "");
  normalized = normalized.replace(/^git:\/\//, "");
  normalized = normalized.replace(/^ssh:\/\//, "");

  // SSH shorthand: git@github.com:owner/repo → github.com/owner/repo
  normalized = normalized.replace(/^git@([^:]+):/, "$1/");

  // Strip trailing .git and slashes.
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  normalized = normalized.replace(/\/$/, "");

  return normalized;
}

export function normalizePath(absolutePath: string): string {
  return absolutePath.trim().replace(/\\/g, "/").replace(/\/$/, "");
}

export function sha256HexFirst32(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

export function requireIdentity(cwd: string): Promise<ProjectIdentity> {
  return computeIdentity(cwd).catch((err) => {
    throw new CliError("Could not compute project identity", {
      code: "identity_error",
      cause: err,
    });
  });
}
