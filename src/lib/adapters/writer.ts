/**
 * Safe file writers used by hook adapters.
 *
 * Ported from the gortex concepts:
 *   - Atomic temp-write + rename
 *   - Marker-guarded idempotent block replacement
 *   - JSON/JSONC merge preserving unrelated user keys
 */

import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface MarkerBlock {
  startMarker: string;
  endMarker: string;
  content: string;
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tempPath, content, { mode: 0o644 });
  try {
    await rename(tempPath, filePath);
  } catch {
    await rm(tempPath, { force: true });
    throw new Error(`Failed to write ${filePath}`);
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function stripJsonComments(json: string): string {
  // Minimal JSONC stripper sufficient for Claude Code settings files:
  // handles // line comments and /* */ block comments.
  return json
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
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

export function markerBlock(
  scope: string,
  content: string,
  { commentPrefix = "<!--" as string, commentSuffix = "-->" as string } = {},
): MarkerBlock {
  const startMarker = `${commentPrefix} bluud:${scope}:start ${commentSuffix}`;
  const endMarker = `${commentPrefix} bluud:${scope}:end ${commentSuffix}`;
  return { startMarker, endMarker, content };
}

export async function removeMarkerBlockFile(
  filePath: string,
  scope: string,
  { commentPrefix = "<!--", commentSuffix = "-->" } = {},
): Promise<boolean> {
  const existing = await readTextFile(filePath);
  if (existing === null) return false;

  const startMarker = `${commentPrefix} bluud:${scope}:start ${commentSuffix}`;
  const endMarker = `${commentPrefix} bluud:${scope}:end ${commentSuffix}`;
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return false;

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + endMarker.length);
  await atomicWriteFile(filePath, `${before}${after}`.replace(/\n\n+/g, "\n\n"));
  return true;
}

export { existsSync, join, mkdir, rm };
