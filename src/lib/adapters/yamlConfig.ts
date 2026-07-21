/**
 * Comment-preserving YAML merge, the YAML counterpart to `writer.ts`'s
 * `mergeJsonFile`.
 *
 * Hermes is the only tool Bluud configures whose settings live in YAML
 * (`~/.hermes/config.yaml`), and unlike the JSON files the other adapters
 * touch, a Hermes config is routinely hand-written and commented: model
 * choices, profile notes, and per-hook rationale all ride in `#` comments. A
 * parse-then-re-serialize round trip through `JSON.parse`-style plain objects
 * would silently delete every one of them, which is why this goes through the
 * `yaml` package's document API (`parseDocument`) rather than `parse`: the
 * document retains comments, key order, anchors, and scalar styles, and only
 * the nodes actually mutated are rewritten.
 *
 * `yaml` is already a direct dependency (`skillVersion.ts` uses it to stamp the
 * bundled skill's frontmatter), so this adds no new external requirement.
 */

import { parseDocument, isMap, isSeq, isScalar, Document, Scalar, YAMLMap, YAMLSeq } from "yaml";
import type { Node } from "yaml";
import { atomicWriteFile, readTextFile } from "./writer.js";

/**
 * Read `filePath`, hand the parsed document to `mutate`, and write it back
 * when `mutate` reports a change.
 *
 * Returns `true` only when the file was actually rewritten. A file that does
 * not parse as YAML is left strictly alone (`false`) rather than replaced with
 * a freshly generated one — the same refusal `mergeJsonFile` makes for invalid
 * JSON, and for the same reason: a config Bluud cannot read is far more likely
 * to be mid-edit than to be garbage, and clobbering it destroys user work.
 */
export async function mergeYamlFile(
  filePath: string,
  mutate: (doc: Document) => boolean,
): Promise<boolean> {
  const existing = await readTextFile(filePath);

  let doc: Document;
  if (existing === null) {
    doc = new Document({});
  } else {
    const parsed = parseDocument(existing);
    if (parsed.errors.length > 0) return false;
    doc = parsed;
    // `key:` with nothing under it, or a wholly empty file, parses to a null
    // document body. Give it a mapping to merge into rather than refusing.
    if (doc.contents === null) {
      doc.contents = doc.createNode({}) as never;
    }
    if (!isMap(doc.contents)) return false;
  }

  if (!mutate(doc)) return false;

  const serialized = doc.toString({ lineWidth: 0 });
  if (serialized === existing) return false;

  await atomicWriteFile(filePath, serialized);
  return true;
}

/**
 * The mapping stored at `key`, creating it when the key is absent or holds an
 * explicit null (`hooks:` with nothing beneath it).
 *
 * Returns `null` when `key` holds something that is neither a mapping nor
 * null — a scalar or a list. That shape is not one a mapping can be spliced
 * into, and overwriting it would discard whatever the user meant by it, so the
 * caller is expected to abandon the write instead.
 */
export function ensureMap(parent: YAMLMap | Document, key: string): YAMLMap | null {
  const current = parent.get(key, true) as unknown;

  if (current === undefined || current === null || isNullScalar(current)) {
    const created = new YAMLMap();
    parent.set(key, created);
    return created;
  }
  if (isMap(current)) return current as YAMLMap;
  return null;
}

/**
 * The sequence stored at `key`, creating it when absent or null. Returns
 * `null` for a non-sequence value, on the same reasoning as `ensureMap`.
 */
export function ensureSeq(parent: YAMLMap, key: string): YAMLSeq | null {
  const current = parent.get(key, true) as unknown;

  if (current === undefined || current === null || isNullScalar(current)) {
    const created = new YAMLSeq();
    parent.set(key, created);
    return created;
  }
  if (isSeq(current)) return current as YAMLSeq;
  return null;
}

/** A YAML null: an explicit `~`/`null` scalar, or a key with an empty value. */
function isNullScalar(node: unknown): boolean {
  return isScalar(node) && ((node as Scalar).value === null || (node as Scalar).value === "");
}

/** The string value of a scalar at `key`, or `null` for anything else. */
export function scalarAt(map: YAMLMap, key: string): string | null {
  const node = map.get(key, true) as unknown;
  if (!isScalar(node)) return null;
  const value = (node as Scalar).value;
  return typeof value === "string" ? value : null;
}

/**
 * A double-quoted string scalar.
 *
 * Quoting is forced rather than left to the serializer because these values
 * are filesystem paths: a Windows path, a value with a leading `~`, or one
 * containing `:` are all cases where YAML's plain style either changes the
 * meaning or fails to round-trip. Double quotes are also the style Hermes' own
 * documented hook examples use, so a Bluud-written entry is visually
 * indistinguishable from a hand-written one.
 */
export function quoted(value: string): Scalar {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

/** A plain integer scalar. */
export function int(value: number): Scalar {
  return new Scalar(value);
}

/**
 * Remove every item from `seq` for which `predicate` is true, returning how
 * many were dropped. Used by the uninstall path to withdraw Bluud's own hook
 * entry while leaving every neighbouring entry — and the comments attached to
 * them — untouched.
 */
export function removeFromSeq(seq: YAMLSeq, predicate: (item: Node) => boolean): number {
  const before = seq.items.length;
  seq.items = (seq.items as Node[]).filter((item) => !predicate(item));
  return before - seq.items.length;
}
