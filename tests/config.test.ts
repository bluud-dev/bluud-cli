import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigDir,
  getAuthPath,
  getProjectTokenPath,
  saveAuth,
  loadAuth,
  clearAuth,
  saveProjectToken,
  loadProjectToken,
  ensureConfigDir,
} from "../src/lib/config.js";

let originalConfigDir: string | undefined;

describe("config", () => {
  let tempConfig: string;

  beforeEach(async () => {
    tempConfig = await mkdtemp(join(tmpdir(), "bluud-cli-test-"));
    originalConfigDir = process.env.BLUUD_CONFIG_DIR;
    process.env.BLUUD_CONFIG_DIR = tempConfig;
    await clearAuth();
  });

  afterEach(async () => {
    await rm(tempConfig, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.BLUUD_CONFIG_DIR;
    } else {
      process.env.BLUUD_CONFIG_DIR = originalConfigDir;
    }
  });

  it("resolves config paths under the fixed ~/.bluud (BLUUD_CONFIG_DIR override)", () => {
    expect(getConfigDir()).toBe(tempConfig);
    expect(getAuthPath()).toBe(join(tempConfig, "auth.json"));
    expect(getProjectTokenPath("abc")).toBe(join(tempConfig, "projects", "abc", "token"));
  });

  it("round-trips auth", async () => {
    await ensureConfigDir();
    const session = {
      access_token: "at",
      refresh_token: "rt",
      token_type: "bearer" as const,
    };
    await saveAuth(session, false);
    const loaded = await loadAuth();
    expect(loaded).toEqual({ ...session, isPat: false });
  });

  it("returns null when auth is missing", async () => {
    const loaded = await loadAuth();
    expect(loaded).toBeNull();
  });

  it("clears auth", async () => {
    await saveAuth({ access_token: "a", refresh_token: "r", token_type: "bearer" });
    await clearAuth();
    expect(await loadAuth()).toBeNull();
  });

  it("round-trips project token", async () => {
    await saveProjectToken("proj-123", "bluud_pt_secret");
    const loaded = await loadProjectToken("proj-123");
    expect(loaded).toBe("bluud_pt_secret");
  });
});
