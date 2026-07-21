/**
 * Pure helpers for memory-tree rendering and diff validation.
 *
 * These functions are shared between `bluud pull` and `bluud push` and are
 * deliberately free of side effects so they are easy to unit test.
 */

import { CliError } from "./error.js";
import type { DiffOperation, MemoryNode, MemoryTree } from "../types.js";

const MAX_HEADING_DEPTH = 6;
const QUOTA_WARNING_THRESHOLD = 0.9;

/**
 * Render a memory tree as Markdown suitable for injection into an agent's
 * conversation context. The output is deterministic and stable: the same tree
 * always produces the same string.
 *
 * Nodes are emitted in the preorder order returned by the API. Heading depth
 * is driven by `node.depth` but capped so we never exceed H6.
 */
export function renderMemoryTree(tree: MemoryTree): string {
  if (tree.nodes.length === 0) {
    return "# Bluud project memory\n\nNo memory has been recorded for this project yet.\n";
  }

  const lines: string[] = ["# Bluud project memory", ""];

  for (const node of tree.nodes) {
    lines.push(...renderNode(node));
  }

  return lines.join("\n");
}

function renderNode(node: MemoryNode): string[] {
  const headingLevel = Math.min(node.depth + 2, MAX_HEADING_DEPTH);
  const prefix = "#".repeat(headingLevel);
  const lines: string[] = ["", `${prefix} ${node.title}`];

  if (node.description) {
    lines.push("");
    lines.push(node.description);
  }

  if (node.body) {
    lines.push("");
    lines.push(node.body);
  }

  return lines;
}

/**
 * Render a memory tree as the JSON envelope Gemini CLI's `SessionStart` hook
 * contract requires: hooks must print *only* a single JSON object to stdout
 * (any stray plain text breaks its parser), with the injected text carried in
 * `hookSpecificOutput.additionalContext`.
 *
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
 */
export function renderGeminiHookOutput(tree: MemoryTree): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: renderMemoryTree(tree),
    },
  });
}

/**
 * Render a memory tree as the JSON envelope Cline's `TaskStart` hook contract
 * requires: `contextModification` is folded into the *next* API request (not
 * the current turn) per Cline's hooks documentation.
 *
 * https://docs.cline.bot/features/hooks
 */
export function renderClineHookOutput(tree: MemoryTree): string {
  return JSON.stringify({ contextModification: renderMemoryTree(tree) });
}

/**
 * Render a memory tree as a lightweight index: one entry per node with its
 * `id`, an ancestor-title breadcrumb, `updated_at`, and `description` — never
 * `body`. This is the default entry point for skill-mode reading: an agent
 * scans the index, decides which nodes are relevant to the request at hand,
 * and loads only those with `renderMemoryNodes`. `bluud pull --inject` (no
 * `--index`) remains the unconditional full-tree dump for when an agent
 * genuinely needs everything.
 *
 * Deterministic and side-effect free, like `renderMemoryTree`.
 */
export function renderMemoryIndex(tree: MemoryTree): string {
  if (tree.nodes.length === 0) {
    return "# Bluud project memory (index)\n\nNo memory has been recorded for this project yet.\n";
  }

  const byId = buildNodeIndex(tree);
  const lines: string[] = ["# Bluud project memory (index)", ""];

  for (const node of tree.nodes) {
    lines.push(...renderIndexEntry(node, byId));
  }

  return lines.join("\n");
}

function renderIndexEntry(node: MemoryNode, byId: Map<string, MemoryNode>): string[] {
  const breadcrumb = [...ancestorTitles(node, byId), node.title].join(" > ");
  const lines = [
    "",
    `- ${breadcrumb}`,
    `  id: ${node.id} | updated: ${formatDateOnly(node.updated_at)}`,
  ];

  if (node.description) {
    lines.push(`  ${node.description}`);
  }

  return lines;
}

/**
 * Render only the requested nodes' full content (title, description, body —
 * same shape `renderMemoryTree` uses per node), each preceded by an
 * ancestor-title breadcrumb for orientation, since a selected node is no
 * longer surrounded by its siblings the way a full-tree dump would show it.
 * The breadcrumb carries titles only, never ancestor bodies or descriptions —
 * the whole point of selecting is to avoid pulling in content the agent didn't
 * ask for.
 *
 * Nodes are emitted in the order `ids` was given, not tree order, so the
 * output matches the order the agent asked for them in.
 *
 * Throws `CliError` (`config_error`) on the first id with no matching node,
 * naming that id — a silent partial result would be worse than a loud, exact
 * failure for a follow-up push that assumes every requested node loaded.
 */
export function renderMemoryNodes(tree: MemoryTree, ids: string[]): string {
  const byId = buildNodeIndex(tree);
  const lines: string[] = ["# Bluud project memory (selected)"];

  for (const id of ids) {
    const node = byId.get(id);
    if (!node) {
      throw new CliError(`No memory node found with id ${id}.`, { code: "config_error" });
    }

    const breadcrumb = ancestorTitles(node, byId);
    if (breadcrumb.length > 0) {
      lines.push("", `_${breadcrumb.join(" > ")}_`);
    }
    lines.push(...renderNode(node));
  }

  return lines.join("\n");
}

function buildNodeIndex(tree: MemoryTree): Map<string, MemoryNode> {
  return new Map(tree.nodes.map((node) => [node.id, node]));
}

/**
 * Titles of `node`'s ancestors, root-first, from `parent_id` — never the
 * node's own title. The backend rejects any push that would introduce a
 * parent cycle (BLUUD_PUBLIC_API.md's structural-violation check on
 * `PATCH /memory/{project_id}`), so a pulled tree is guaranteed acyclic and
 * this walk is guaranteed to terminate.
 */
function ancestorTitles(node: MemoryNode, byId: Map<string, MemoryNode>): string[] {
  const titles: string[] = [];
  let current = node.parent_id !== null ? byId.get(node.parent_id) : undefined;
  while (current !== undefined) {
    titles.unshift(current.title);
    current = current.parent_id !== null ? byId.get(current.parent_id) : undefined;
  }
  return titles;
}

/** `updated_at`'s leading `YYYY-MM-DD`, or the raw string if it doesn't match. */
function formatDateOnly(isoTimestamp: string): string {
  const match = isoTimestamp.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : isoTimestamp;
}

/**
 * Return true when the project is near or over its quota. Pull continues to
 * work in this state, but the user (or agent) should be warned.
 */
export function isQuotaWarning(tree: MemoryTree): boolean {
  return tree.quota_usage_ratio >= QUOTA_WARNING_THRESHOLD;
}

/**
 * Format a human-readable quota warning.
 */
export function formatQuotaWarning(tree: MemoryTree): string {
  const percent = Math.round(tree.quota_usage_ratio * 100);
  return `Project memory is at ${percent}% of the storage quota (${tree.total_size_bytes} bytes). Pulls still work, but writes may be blocked.`;
}

/**
 * Validate and narrow an unknown value to a `DiffOperation[]`.
 *
 * Throws `CliError` with `code: "api_error"` when the shape is invalid so the
 * agent gets a clear, actionable message instead of a raw 422 from the server.
 */
export function validateDiffOperations(raw: unknown): DiffOperation[] {
  if (
    raw === null ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { operations?: unknown }).operations)
  ) {
    throw new CliError("Push payload must be an object with an 'operations' array.", {
      code: "api_error",
    });
  }

  const { operations } = raw as { operations: unknown[] };
  const validated: DiffOperation[] = [];

  for (let i = 0; i < operations.length; i++) {
    validated.push(validateOperation(operations[i], i));
  }

  return validated;
}

function validateOperation(op: unknown, index: number): DiffOperation {
  if (op === null || typeof op !== "object") {
    throw new CliError(`Operation at index ${index} must be an object.`, { code: "api_error" });
  }

  const { op: kind, id, document } = op as Record<string, unknown>;

  if (kind !== "create" && kind !== "update" && kind !== "delete") {
    throw new CliError(
      `Operation at index ${index} has invalid 'op': expected "create", "update", or "delete" but got ${JSON.stringify(kind)}.`,
      { code: "api_error" },
    );
  }

  if (kind === "delete") {
    if (typeof id !== "string" || id.length === 0) {
      throw new CliError(`Delete operation at index ${index} requires a non-empty 'id' string.`, {
        code: "api_error",
      });
    }
    return { op: "delete", id };
  }

  // create or update
  if (typeof document !== "string" || document.length === 0) {
    throw new CliError(
      `${capitalize(kind)} operation at index ${index} requires a non-empty 'document' string.`,
      { code: "api_error" },
    );
  }

  if (kind === "create") {
    if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
      throw new CliError(`Create operation at index ${index} has an invalid 'id' string.`, {
        code: "api_error",
      });
    }
    return { op: "create", document, ...(id !== undefined ? { id } : {}) };
  }

  // update
  if (typeof id !== "string" || id.length === 0) {
    throw new CliError(`Update operation at index ${index} requires a non-empty 'id' string.`, {
      code: "api_error",
    });
  }
  return { op: "update", id, document };
}

function capitalize(input: string): string {
  if (input.length === 0) return input;
  return input[0].toUpperCase() + input.slice(1);
}
