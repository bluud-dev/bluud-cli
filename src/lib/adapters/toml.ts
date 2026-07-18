/**
 * Minimal, correct-for-our-purpose TOML helpers.
 *
 * Bluud never needs to parse or rewrite arbitrary TOML: the two tools that use
 * it for hook configuration (Codex CLI, Kimi Code CLI) both express hooks as
 * *array-of-tables* (`[[hooks.SessionStart]]`, `[[hooks]]`). TOML array-of-
 * tables entries are additive and order-independent with respect to any other
 * table in the document, so appending a new, well-formed, marker-guarded block
 * is a structurally correct merge: it can never collide with or corrupt an
 * unrelated key or table the user already has, and re-running the adapter
 * only ever touches the fenced block (see `writer.ts`'s marker-guarded region
 * replace). This avoids hand-rolling a full TOML parser (and the associated
 * risk of misinterpreting rare TOML syntax) while still satisfying "merge
 * preserving user keys" for the concrete shapes these two tools require.
 */

import { join } from "node:path";
import {
  markerBlock,
  writeMarkerBlockFile,
  removeMarkerBlockFile,
  readTextFile,
  type MarkerBlock,
} from "./writer.js";

/** Comment syntax to pass to the marker-block helpers for a `.toml` file. */
export const TOML_COMMENT = { commentPrefix: "#", commentSuffix: "" };

/**
 * Render a Bluud-owned TOML value as a literal string (single-quoted).
 *
 * TOML literal strings perform no escape processing, which makes them the
 * correct choice for absolute binary paths (Windows backslashes must not be
 * interpreted as escapes). Falls back to an escaped basic string only if the
 * value itself contains a single quote (which a binary path realistically
 * never does).
 */
export function tomlString(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * True when `filePath` (if it exists) already contains the literal command
 * string anywhere in the file. Used as the idempotency check before appending
 * a new TOML block — cheaper and safer than parsing, and sufficient because
 * the command string is what uniquely identifies "this hook is already wired."
 */
export async function tomlFileContains(filePath: string, literal: string): Promise<boolean> {
  const existing = await readTextFile(filePath);
  return existing !== null && existing.includes(literal);
}

export function tomlMarkerBlock(scope: string, content: string): MarkerBlock {
  return markerBlock(scope, content, TOML_COMMENT);
}

export async function writeTomlMarkerBlockFile(
  filePath: string,
  scope: string,
  content: string,
): Promise<void> {
  await writeMarkerBlockFile(filePath, tomlMarkerBlock(scope, content));
}

export async function removeTomlMarkerBlockFile(filePath: string, scope: string): Promise<boolean> {
  return removeMarkerBlockFile(filePath, scope, TOML_COMMENT);
}

export { join };
