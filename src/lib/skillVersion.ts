/**
 * Version pinning for the bundled `SKILL.md`.
 *
 * The skill ships inside the `bluud` npm package (BLUUD_CLI_ARCHITECTURE.md
 * decision #4: "CLI-bundled local skill files … version-pinned to the CLI"),
 * so its version is not hand-maintained — it is stamped from `package.json`
 * into the skill's own frontmatter at build time (`tsup.config.ts`'s
 * `onSuccess`), the same moment the skill directory is copied into `dist/`.
 * That keeps a single source of truth (the package version) and makes the
 * pin verifiable after the fact: `readSkillVersion` parses it back out of an
 * installed or bundled `SKILL.md`, which is how `bluud doctor` reports which
 * skill version is actually on disk versus which CLI is running.
 *
 * The frontmatter delimiter regex here is intentionally the same one used by
 * `tests/skill.test.ts` and by `skills`' own `src/frontmatter.ts` (see that
 * test file's header comment) — the three copies are a deliberate, tracked
 * duplication of a single stable pattern, not drift.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface ParsedSkill {
  data: Record<string, unknown>;
  body: string;
}

function parseSkillFrontmatter(markdown: string): ParsedSkill | null {
  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) return null;
  const data = (parseYaml(match[1] as string) as Record<string, unknown>) ?? {};
  return { data, body: match[2] ?? "" };
}

/**
 * Stamp `version` into the skill's `metadata.version` frontmatter field,
 * preserving every other key and the body verbatim.
 *
 * Throws when `markdown` has no parseable YAML frontmatter — a skill file
 * that cannot be version-pinned is a build error, not a value to silently
 * pass through unpinned.
 */
export function stampSkillVersion(markdown: string, version: string): string {
  const parsed = parseSkillFrontmatter(markdown);
  if (!parsed) {
    throw new Error("stampSkillVersion: SKILL.md has no parseable YAML frontmatter.");
  }
  const metadata = (parsed.data.metadata as Record<string, unknown> | undefined) ?? {};
  const data = { ...parsed.data, metadata: { ...metadata, version } };
  const frontmatter = stringifyYaml(data).trimEnd();
  return `---\n${frontmatter}\n---\n${parsed.body}`;
}

/**
 * Read the version previously stamped by `stampSkillVersion`, or `null` when
 * the file has no frontmatter, no `metadata.version`, or the value isn't a
 * string.
 *
 * `null` is the expected result when running from an unbuilt source checkout
 * (`bundledSkillPath()` falls back to `src/skill`, which is never stamped —
 * only the `dist/skill` copy the build step produces is).
 */
export function readSkillVersion(markdown: string): string | null {
  const parsed = parseSkillFrontmatter(markdown);
  if (!parsed) return null;
  const metadata = parsed.data.metadata as Record<string, unknown> | undefined;
  const version = metadata?.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}
