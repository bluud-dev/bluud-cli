import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteFile,
  markerBlock,
  mergeJsonFile,
  readTextFile,
  removeMarkerBlockFile,
  replaceMarkerBlock,
  stripJsonComments,
  writeMarkerBlockFile,
} from "../../src/lib/adapters/writer.js";

let workDir: string;

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  workDir = await mkdtemp(join(tmpdir(), "bluud-writer-test-"));
  return workDir;
}

describe("stripJsonComments", () => {
  it("strips // line comments outside strings", () => {
    const input = '{\n  // a comment\n  "a": 1\n}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
  });

  it("strips /* */ block comments outside strings", () => {
    const input = '{ /* block\n comment */ "a": 1 }';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
  });

  it("does NOT corrupt a string value containing //", () => {
    const input = '{ "url": "https://example.com/path" }';
    const stripped = stripJsonComments(input);
    expect(JSON.parse(stripped)).toEqual({ url: "https://example.com/path" });
  });

  it("does NOT corrupt a string value containing /*", () => {
    const input = '{ "note": "1/* not a comment */2" }';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ note: "1/* not a comment */2" });
  });

  it("does NOT corrupt a Windows path with backslashes inside a string", () => {
    const input = String.raw`{ "command": "C:\\Users\\dev\\bluud.exe pull" }`;
    const stripped = stripJsonComments(input);
    expect(JSON.parse(stripped)).toEqual({ command: String.raw`C:\Users\dev\bluud.exe pull` });
  });

  it("tolerates trailing commas", () => {
    const input = '{\n  "a": 1,\n  "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1, b: [1, 2] });
  });

  it("handles an escaped quote inside a string without ending it early", () => {
    const input = String.raw`{ "s": "a \" // still inside\" b" }`;
    // The string contains an escaped quote followed by `//`; a naive stripper
    // would treat the `//` as a real comment because it mis-tracks string end.
    const stripped = stripJsonComments(input);
    expect(() => JSON.parse(stripped)).not.toThrow();
  });
});

describe("atomicWriteFile / readTextFile", () => {
  it("writes a file that can be read back and creates parent dirs", async () => {
    const dir = await tempDir();
    const target = join(dir, "nested", "settings.json");
    await atomicWriteFile(target, '{"a":1}');
    expect(await readTextFile(target)).toBe('{"a":1}');
  });

  it("returns null from readTextFile for a missing file", async () => {
    const dir = await tempDir();
    expect(await readTextFile(join(dir, "missing.json"))).toBeNull();
  });

  it("leaves no temp files behind after a successful write", async () => {
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    await atomicWriteFile(target, "content");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["settings.json"]);
  });
});

describe("mergeJsonFile", () => {
  it("creates a new file when none exists", async () => {
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    const ok = await mergeJsonFile<Record<string, unknown>>(target, (current) => ({
      ...current,
      added: true,
    }));
    expect(ok).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ added: true });
  });

  it("preserves unrelated existing keys", async () => {
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    await writeFile(target, JSON.stringify({ existingKey: "keep-me", nested: { x: 1 } }), "utf8");

    await mergeJsonFile<Record<string, unknown>>(target, (current) => ({
      ...current,
      added: true,
    }));

    const result = JSON.parse(await readFile(target, "utf8"));
    expect(result).toEqual({ existingKey: "keep-me", nested: { x: 1 }, added: true });
  });

  it("preserves unrelated keys even when the source file is JSONC with comments", async () => {
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    await writeFile(target, '{\n  // a user comment\n  "existingKey": "keep-me"\n}', "utf8");

    await mergeJsonFile<Record<string, unknown>>(target, (current) => ({
      ...current,
      added: true,
    }));

    const result = JSON.parse(await readFile(target, "utf8"));
    expect(result).toEqual({ existingKey: "keep-me", added: true });
  });

  it("leaves the file untouched and returns false when it is not valid JSON", async () => {
    const dir = await tempDir();
    const target = join(dir, "settings.json");
    await writeFile(target, "not { valid json", "utf8");

    const ok = await mergeJsonFile<Record<string, unknown>>(target, (current) => ({
      ...current,
      added: true,
    }));

    expect(ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("not { valid json");
  });
});

describe("marker-guarded block replace", () => {
  it("inserts a new block into an empty file", () => {
    const block = markerBlock("scope", "hello");
    const result = replaceMarkerBlock("", block);
    expect(result).toBe(`${block.startMarker}\n${block.content}\n${block.endMarker}\n`);
  });

  it("replaces only the fenced region on re-apply, preserving surrounding content", () => {
    const block1 = markerBlock("scope", "first");
    const withFirst = replaceMarkerBlock("# Title\n\nUser content.\n", block1);
    expect(withFirst).toContain("# Title");
    expect(withFirst).toContain("User content.");
    expect(withFirst).toContain("first");

    const block2 = markerBlock("scope", "second");
    const withSecond = replaceMarkerBlock(withFirst, block2);
    expect(withSecond).toContain("# Title");
    expect(withSecond).toContain("User content.");
    expect(withSecond).toContain("second");
    expect(withSecond).not.toContain("first");
  });

  it("round-trips through writeMarkerBlockFile / removeMarkerBlockFile", async () => {
    const dir = await tempDir();
    const target = join(dir, "CLAUDE.md");
    await writeFile(target, "# Project notes\n\nKeep this.\n", "utf8");

    await writeMarkerBlockFile(target, markerBlock("memory", "managed content"));
    let content = await readFile(target, "utf8");
    expect(content).toContain("Keep this.");
    expect(content).toContain("managed content");

    const removed = await removeMarkerBlockFile(target, "memory");
    expect(removed).toBe(true);
    content = await readFile(target, "utf8");
    expect(content).toContain("Keep this.");
    expect(content).not.toContain("managed content");
  });

  it("supports TOML-style `#` comment markers with no closing token", () => {
    const block = markerBlock("hooks", 'command = "x"', { commentPrefix: "#", commentSuffix: "" });
    expect(block.startMarker).toBe("# bluud:hooks:start");
    expect(block.endMarker).toBe("# bluud:hooks:end");
    expect(block.startMarker.endsWith(" ")).toBe(false);
  });
});
