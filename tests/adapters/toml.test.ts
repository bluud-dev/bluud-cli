import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  removeTomlMarkerBlockFile,
  tomlFileContains,
  tomlString,
  writeTomlMarkerBlockFile,
} from "../../src/lib/adapters/toml.js";

let workDir: string;

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  workDir = await mkdtemp(join(tmpdir(), "bluud-toml-test-"));
  return workDir;
}

describe("tomlString", () => {
  it("wraps a plain value in single quotes (TOML literal string)", () => {
    expect(tomlString("hello")).toBe("'hello'");
  });

  it("uses a literal string for Windows paths so backslashes are not escape sequences", () => {
    expect(tomlString(String.raw`C:\Users\dev\bluud.exe`)).toBe(
      String.raw`'C:\Users\dev\bluud.exe'`,
    );
  });

  it("falls back to a double-quoted basic string when the value contains a single quote", () => {
    const result = tomlString("it's-a-path");
    expect(result).toBe(`"it's-a-path"`);
  });

  it("escapes backslashes and double quotes inside the basic-string fallback", () => {
    const result = tomlString(String.raw`it's a "quoted" \path`);
    expect(result).toBe(String.raw`"it's a \"quoted\" \\path"`);
  });
});

describe("tomlFileContains", () => {
  it("returns false for a missing file", async () => {
    const dir = await tempDir();
    expect(await tomlFileContains(join(dir, "missing.toml"), "anything")).toBe(false);
  });

  it("returns true when the literal is present", async () => {
    const dir = await tempDir();
    const target = join(dir, "config.toml");
    await writeFile(target, "command = 'bluud pull --inject'\n", "utf8");
    expect(await tomlFileContains(target, "bluud pull --inject")).toBe(true);
  });
});

describe("writeTomlMarkerBlockFile / removeTomlMarkerBlockFile", () => {
  it("appends a well-formed array-of-tables block without disturbing existing content", async () => {
    const dir = await tempDir();
    const target = join(dir, "config.toml");
    await writeFile(
      target,
      ['model = "gpt-5-codex"', "", "[mcp_servers.other]", 'command = "other-tool"', ""].join("\n"),
      "utf8",
    );

    await writeTomlMarkerBlockFile(
      target,
      "session-start",
      ["[[hooks.SessionStart]]", 'matcher = "startup|resume"'].join("\n"),
    );

    const content = await readFile(target, "utf8");
    expect(content).toContain('model = "gpt-5-codex"');
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain("[[hooks.SessionStart]]");
    expect(content).toContain("# bluud:session-start:start");
    expect(content).toContain("# bluud:session-start:end");
  });

  it("replaces only the fenced block on re-apply (idempotent)", async () => {
    const dir = await tempDir();
    const target = join(dir, "config.toml");
    await writeFile(target, "existing = true\n", "utf8");

    await writeTomlMarkerBlockFile(target, "session-start", "command = 'first'");
    await writeTomlMarkerBlockFile(target, "session-start", "command = 'second'");

    const content = await readFile(target, "utf8");
    expect(content).toContain("existing = true");
    expect(content).toContain("command = 'second'");
    expect(content).not.toContain("command = 'first'");
    // Only one marker pair should exist.
    expect(content.match(/# bluud:session-start:start/g)?.length).toBe(1);
  });

  it("removes the block cleanly, leaving unrelated content intact", async () => {
    const dir = await tempDir();
    const target = join(dir, "config.toml");
    await writeFile(target, "existing = true\n", "utf8");
    await writeTomlMarkerBlockFile(target, "session-start", "command = 'x'");

    const removed = await removeTomlMarkerBlockFile(target, "session-start");
    expect(removed).toBe(true);

    const content = await readFile(target, "utf8");
    expect(content).toContain("existing = true");
    expect(content).not.toContain("command = 'x'");
    expect(content).not.toContain("bluud:session-start");
  });

  it("returns false when removing from a file with no matching block", async () => {
    const dir = await tempDir();
    const target = join(dir, "config.toml");
    await writeFile(target, "existing = true\n", "utf8");
    expect(await removeTomlMarkerBlockFile(target, "session-start")).toBe(false);
  });
});
