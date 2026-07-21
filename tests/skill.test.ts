/**
 * Contract tests for the bundled `SKILL.md`.
 *
 * The `skills` CLI is the delivery engine, and it is strict in a way that
 * fails silently from Bluud's side: `parseSkillMd` (its `src/skills.ts`)
 * returns null for any SKILL.md whose YAML frontmatter lacks a **string**
 * `name` and `description`, after which `skills add` reports only "No valid
 * skills found. Skills require a SKILL.md with name and description." and
 * exits — the Bluud install then falls back to a copy and the tool never sees
 * a registered skill.
 *
 * These tests reimplement `skills`' own parse and `--skill` matching exactly
 * (its frontmatter regex, and `filterSkills`' case-insensitive name compare)
 * so the contract is verified against the real file rather than assumed.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BLUUD_SKILL_NAME, bundledSkillPath } from "../src/lib/skills.js";

/** Verbatim from `skills`' `src/frontmatter.ts`. */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };
  const data = (parseYaml(match[1] as string) as Record<string, unknown>) ?? {};
  return { data, content: match[2] ?? "" };
}

async function readSkill(): Promise<string> {
  return readFile(join(bundledSkillPath(), "SKILL.md"), "utf8");
}

describe("bundled SKILL.md", () => {
  it("has frontmatter the skills installer will accept", async () => {
    const { data } = parseFrontmatter(await readSkill());

    expect(typeof data.name).toBe("string");
    expect(typeof data.description).toBe("string");
    expect((data.name as string).length).toBeGreaterThan(0);
    expect((data.description as string).length).toBeGreaterThan(0);
  });

  it("declares the exact name the CLI passes to `skills add --skill`", async () => {
    const { data } = parseFrontmatter(await readSkill());

    // `filterSkills` compares lowercased, so match its semantics.
    expect((data.name as string).toLowerCase()).toBe(BLUUD_SKILL_NAME.toLowerCase());
  });

  it("is not marked internal, which would hide it from a normal install", async () => {
    const { data } = parseFrontmatter(await readSkill());

    // `parseSkillMd` drops skills whose `metadata.internal === true` unless
    // INSTALL_INTERNAL_SKILLS is set.
    const metadata = data.metadata as Record<string, unknown> | undefined;
    expect(metadata?.internal).not.toBe(true);
  });

  it("documents the commands and the diff contract the agent actually needs", async () => {
    const { content } = parseFrontmatter(await readSkill());

    // Reading, and the JSON form that is the only way to obtain node ids.
    expect(content).toContain("bluud pull --inject");
    expect(content).toContain("bluud pull --json");
    // Writing, via stdin.
    expect(content).toContain("bluud push");
    expect(content).toContain("operations");
    // The three ops the CLI validates.
    for (const op of ["create", "update", "delete"]) {
      expect(content).toContain(op);
    }
  });

  it("describes `parent` as a UUID, not a title", async () => {
    const { content } = parseFrontmatter(await readSkill());

    // Regression: an earlier revision told the agent `parent` was "the title
    // of the parent node". The backend parses it as a UUID
    // (`memory_tree.py` `_parse_node`), so every such push was rejected.
    expect(content).toMatch(/`parent`[\s\S]{0,80}UUID/);
    expect(content).not.toMatch(/`parent` is the title/);
  });

  it("covers the read-only quota state and the token secrecy rule", async () => {
    const { content } = parseFrontmatter(await readSkill());

    expect(content.toLowerCase()).toContain("read-only");
    expect(content).toContain("~/.bluud/projects/");
  });

  it("teaches index-first reading as the default, not a full-tree dump", async () => {
    const { content } = parseFrontmatter(await readSkill());

    expect(content).toContain("bluud pull --inject --index");
    expect(content).toContain("bluud pull --inject --id");
    // Bare `--inject` (not immediately followed by another flag on the same
    // line) must still be documented as the explicit full-tree escape hatch,
    // not removed — the whole point is that it stays available.
    expect(content).toMatch(/`bluud pull --inject`(?! --)/);
  });

  it("documents --id as repeatable, for loading more than one node at once", async () => {
    const { content } = parseFrontmatter(await readSkill());

    expect(content).toContain("repeatable");
  });

  it("frames the full-tree dump as the exception, reached for only when judged necessary", async () => {
    const { content } = parseFrontmatter(await readSkill());

    expect(content.toLowerCase()).toContain("not the default");
  });
});
