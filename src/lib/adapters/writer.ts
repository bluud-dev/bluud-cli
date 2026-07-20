/**
 * Safe file writers used by hook adapters.
 *
 * Ported from the gortex concepts:
 *   - Atomic temp-write + rename
 *   - Marker-guarded idempotent block replacement
 *   - JSON/JSONC merge preserving unrelated user keys
 */

import { readFile, writeFile, rename, mkdir, rm, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface MarkerBlock {
  startMarker: string;
  endMarker: string;
  content: string;
}

/**
 * Distinctive infix in every temp file `atomicWriteFile` creates.
 *
 * A crash between the write and the rename strands the temp on disk, and the
 * success path only ever consumes *this* write's temp. Sharing one constant
 * between the writer and the sweeper keeps `cleanStaleTempFiles` from ever
 * drifting out of sync with the names it is meant to match.
 */
const TEMP_INFIX = ".bluud.tmp-";

/**
 * How long an orphaned temp must sit untouched before a later write reaps it.
 * It only has to exceed the lifetime of one in-flight `atomicWriteFile` — a
 * small write plus `renameWithRetry`'s ~275 ms worst case — so an hour is
 * orders of magnitude of headroom and guarantees a temp another writer is
 * still filling is never mistaken for debris.
 */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * Errors that mean "the destination is momentarily locked", not "this write is
 * impossible".
 *
 * On Windows `rename` maps to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, which
 * fails with `ERROR_SHARING_VIOLATION` / `ERROR_ACCESS_DENIED` while another
 * process holds the destination open without `FILE_SHARE_DELETE`. For the
 * files Bluud writes that is a routine event, not a rare one: `settings.json`
 * and `CLAUDE.md` inside a tool's own config directory are exactly what that
 * tool, its language server, an antivirus scanner, or a search indexer keeps
 * open. Those holders release within milliseconds.
 *
 * On POSIX `rename` over an open file is legal, so none of these codes occur
 * for this reason and the retry loop collapses to a single attempt with no
 * added latency.
 */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function isRetryableRenameError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    RETRYABLE_RENAME_CODES.has((err as { code: string }).code)
  );
}

/**
 * Rename with a short bounded backoff on transient Windows sharing violations,
 * mirroring gortex's `renameWithRetry` (`internal/agents/writer.go`). A
 * non-retryable error is rethrown on the first attempt so a genuine
 * permissions failure still surfaces immediately.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = 10;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt === attempts - 1) {
        throw err;
      }
      await delay((attempt + 1) * 5);
    }
  }
}

/**
 * Best-effort removal of temp files an earlier write orphaned in `dir`.
 *
 * Only files carrying Bluud's own infix *and* untouched for longer than
 * `STALE_TEMP_AGE_MS` are removed. Every error is swallowed: this is directory
 * hygiene, not a load-bearing step — a write must never fail because a
 * leftover could not be reaped.
 */
async function cleanStaleTempFiles(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const cutoff = Date.now() - STALE_TEMP_AGE_MS;
  await Promise.all(
    entries
      .filter((name) => name.includes(TEMP_INFIX))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) {
            await rm(path, { force: true });
          }
        } catch {
          // Vanished or unreadable — nothing to sweep from here.
        }
      }),
  );
}

/**
 * Write `content` to `filePath` atomically: a temp file in the same directory
 * followed by a rename, so a concurrent reader sees either the old file or the
 * fully-written new one, never a half-written state. Writing the temp beside
 * the destination (rather than in the system temp dir) keeps the rename on one
 * filesystem, where it is atomic — a cross-device rename would fall back to a
 * copy and lose that guarantee.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await cleanStaleTempFiles(dir);

  const tempPath = `${filePath}${TEMP_INFIX}${randomBytes(4).toString("hex")}`;
  await writeFile(tempPath, content, { mode: 0o644 });
  try {
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true });
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write ${filePath}: ${reason}`);
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * String-aware JSONC comment stripper.
 *
 * A naive regex-based stripper corrupts any JSON string value that itself
 * contains `//` or `/*` (e.g. a URL in a hook command or a Windows path).
 * This walks the source character-by-character, tracking whether the cursor
 * is inside a string literal (respecting backslash escapes) and only treats
 * `//` / `/* ... *\/` as comments outside of strings. Trailing commas before
 * `}` or `]` are also tolerated, matching common JSONC dialects (including
 * Claude Code's settings files).
 */
export function stripJsonComments(json: string): string {
  let out = "";
  let i = 0;
  const len = json.length;
  let inString = false;
  let stringQuote = "";

  while (i < len) {
    const ch = json[i] as string;
    const next = json[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < len) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && json[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(json[i] === "*" && json[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Tolerate trailing commas: ",\s*}" -> "}", ",\s*]" -> "]".
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function mergeJsonFile<T extends Record<string, unknown>>(
  filePath: string,
  mutate: (current: T) => T,
): Promise<boolean> {
  let current: T = {} as T;
  const existing = await readTextFile(filePath);
  if (existing !== null) {
    try {
      current = JSON.parse(stripJsonComments(existing)) as T;
    } catch {
      // If the file is not valid JSON, leave it untouched rather than corrupt it.
      return false;
    }
  }

  const next = mutate(current);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  await atomicWriteFile(filePath, serialized);
  return true;
}

export function replaceMarkerBlock(text: string, block: MarkerBlock): string {
  const { startMarker, endMarker, content } = block;
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);

  const replacement = `${startMarker}\n${content}\n${endMarker}`;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return text.slice(0, startIdx) + replacement + text.slice(endIdx + endMarker.length);
  }

  if (text.length > 0 && !text.endsWith("\n")) {
    return `${text}\n${replacement}\n`;
  }
  return `${text}${replacement}\n`;
}

export async function writeMarkerBlockFile(filePath: string, block: MarkerBlock): Promise<void> {
  const existing = (await readTextFile(filePath)) ?? "";
  const next = replaceMarkerBlock(existing, block);
  await atomicWriteFile(filePath, next);
}

function buildMarkers(
  scope: string,
  commentPrefix: string,
  commentSuffix: string,
): { startMarker: string; endMarker: string } {
  const suffix = commentSuffix ? ` ${commentSuffix}` : "";
  return {
    startMarker: `${commentPrefix} bluud:${scope}:start${suffix}`,
    endMarker: `${commentPrefix} bluud:${scope}:end${suffix}`,
  };
}

export function markerBlock(
  scope: string,
  content: string,
  { commentPrefix = "<!--" as string, commentSuffix = "-->" as string } = {},
): MarkerBlock {
  const { startMarker, endMarker } = buildMarkers(scope, commentPrefix, commentSuffix);
  return { startMarker, endMarker, content };
}

export async function removeMarkerBlockFile(
  filePath: string,
  scope: string,
  { commentPrefix = "<!--", commentSuffix = "-->" } = {},
): Promise<boolean> {
  const existing = await readTextFile(filePath);
  if (existing === null) return false;

  const { startMarker, endMarker } = buildMarkers(scope, commentPrefix, commentSuffix);
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return false;

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + endMarker.length);
  await atomicWriteFile(filePath, `${before}${after}`.replace(/\n\n+/g, "\n\n"));
  return true;
}

export { existsSync, join, mkdir, rm };
