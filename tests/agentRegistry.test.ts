/**
 * Bespoke detection heuristics in `agentRegistry.ts` that are more than a
 * plain "does this config directory exist" check — the ones worth proving
 * were faithfully reproduced from `vendor/skills/src/agents.ts` rather than
 * simplified away. Unlike `detect.test.ts` (which mocks `node:fs` wholesale
 * to test the common directory-probe shape cheaply), these use real
 * temporary directories and a real `process.cwd()`, because the behavior
 * under test — reading a real `package.json`, walking a fallback chain of
 * real directories — is the whole point.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fakeHome = "";

// `os.homedir()` (not `$HOME`) is what `agentRegistry.ts` calls, and that's
// the portable thing to fake — `$HOME` has no effect on Windows, which is a
// real deployment target here, unlike POSIX-only env-var stubbing.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});

import { detectAgent } from "../src/lib/agentRegistry.js";

describe("eve — package.json dependency check, not just a directory probe", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "bluud-eve-"));
    originalCwd = process.cwd();
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("is not detected from an agent/ directory alone", async () => {
    // A directory literally named `agent` is not rare in unrelated projects;
    // upstream requires the `eve` dependency too, and so must this
    // reproduction — simplifying to "agent/ exists" would false-positive on
    // any of those unrelated projects.
    await mkdir(join(cwd, "agent"), { recursive: true });
    expect(await detectAgent("eve")).toBe(false);
  });

  it("is not detected from the eve dependency alone, without an agent/ directory", async () => {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { eve: "^1.0.0" } }),
      "utf8",
    );
    expect(await detectAgent("eve")).toBe(false);
  });

  it("is detected when both an agent/ directory and the eve dependency are present", async () => {
    await mkdir(join(cwd, "agent"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { eve: "^1.0.0" } }),
      "utf8",
    );
    expect(await detectAgent("eve")).toBe(true);
  });

  it("also recognizes the dependency under devDependencies", async () => {
    await mkdir(join(cwd, "agent"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ devDependencies: { eve: "^1.0.0" } }),
      "utf8",
    );
    expect(await detectAgent("eve")).toBe(true);
  });

  it("does not throw on a malformed package.json", async () => {
    await mkdir(join(cwd, "agent"), { recursive: true });
    await writeFile(join(cwd, "package.json"), "{ not valid json", "utf8");
    expect(await detectAgent("eve")).toBe(false);
  });
});

describe("openclaw — three-name rebrand fallback chain", () => {
  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "bluud-openclaw-home-"));
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("detects the current name (.openclaw)", async () => {
    await mkdir(join(fakeHome, ".openclaw"), { recursive: true });
    expect(await detectAgent("openclaw")).toBe(true);
  });

  it("also detects the older rebrand names (.clawdbot, .moltbot)", async () => {
    await mkdir(join(fakeHome, ".moltbot"), { recursive: true });
    expect(await detectAgent("openclaw")).toBe(true);
  });

  it("is not detected when none of the three directories exist", async () => {
    expect(await detectAgent("openclaw")).toBe(false);
  });
});
