import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clineAdapter, uninstallCline } from "../../src/lib/adapters/cline.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;
let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-cline-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-cline-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

describe("clineAdapter", () => {
  it("detect() is false on win32 even when ~/.cline exists", async () => {
    setPlatform("win32");
    const env = await makeEnv();
    await mkdir(join(home, ".cline"), { recursive: true });
    expect(await clineAdapter.detect(env)).toBe(false);
  });

  it("detect() is false on a supported platform when ~/.cline does not exist", async () => {
    setPlatform("linux");
    const env = await makeEnv();
    expect(await clineAdapter.detect(env)).toBe(false);
  });

  it("writes an executable TaskStart script invoking --format=cline (project scope)", async () => {
    setPlatform("linux");
    const env = await makeEnv({ global: false });
    await mkdir(join(home, ".cline"), { recursive: true });

    const result = await clineAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const hookPath = join(cwd, ".clinerules", "hooks", "TaskStart");
    const content = await readFile(hookPath, "utf8");
    expect(content.startsWith("#!/usr/bin/env sh")).toBe(true);
    expect(content).toContain("# bluud:managed");
    expect(content).toContain("BLUUD_BINARY='/usr/local/bin/bluud'");
    expect(content).toContain("BLUUD_FORMAT='cline'");
    // The POSIX template must never pick up CRLF — the kernel would look for
    // an interpreter named `sh\r`.
    expect(content).not.toContain("\r");
  });

  it("writes to the global Documents/Cline/Rules/Hooks path in global scope", async () => {
    setPlatform("darwin");
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".cline"), { recursive: true });

    await clineAdapter.apply(env, { dryRun: false, force: false });

    const hookPath = join(home, "Documents", "Cline", "Rules", "Hooks", "TaskStart");
    expect(existsSync(hookPath)).toBe(true);
  });

  it("is idempotent: re-applying does not change an already-managed hook", async () => {
    setPlatform("linux");
    const env = await makeEnv();
    await mkdir(join(home, ".cline"), { recursive: true });

    await clineAdapter.apply(env, { dryRun: false, force: false });
    const first = await readFile(join(cwd, ".clinerules", "hooks", "TaskStart"), "utf8");
    await clineAdapter.apply(env, { dryRun: false, force: false });
    const second = await readFile(join(cwd, ".clinerules", "hooks", "TaskStart"), "utf8");

    expect(second).toBe(first);
  });

  it("never overwrites a pre-existing user-authored hook without the managed marker", async () => {
    setPlatform("linux");
    const env = await makeEnv();
    await mkdir(join(home, ".cline"), { recursive: true });
    const hooksDir = join(cwd, ".clinerules", "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "TaskStart");
    await writeFile(hookPath, "#!/usr/bin/env sh\necho 'my own hook'\n", "utf8");

    const plan = await clineAdapter.plan(env);
    expect(plan.actions[0].wouldChange).toBe(false);
    expect(plan.actions[0].description).toContain("skipped");

    const result = await clineAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);

    const content = await readFile(hookPath, "utf8");
    expect(content).toBe("#!/usr/bin/env sh\necho 'my own hook'\n");
  });

  it("does not write anything in dry-run mode", async () => {
    setPlatform("linux");
    const env = await makeEnv();
    await mkdir(join(home, ".cline"), { recursive: true });

    await clineAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(join(cwd, ".clinerules", "hooks", "TaskStart"))).toBe(false);
  });

  it("uninstallCline removes a Bluud-managed hook but not a foreign one", async () => {
    setPlatform("linux");
    const env = await makeEnv();
    await mkdir(join(home, ".cline"), { recursive: true });
    await clineAdapter.apply(env, { dryRun: false, force: false });

    const removed = await uninstallCline(env);
    expect(removed).toBe(true);
    expect(existsSync(join(cwd, ".clinerules", "hooks", "TaskStart"))).toBe(false);
  });

  it("uninstallCline refuses to remove a foreign hook", async () => {
    setPlatform("linux");
    const env = await makeEnv();
    const hooksDir = join(cwd, ".clinerules", "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "TaskStart");
    await writeFile(hookPath, "#!/usr/bin/env sh\necho 'my own hook'\n", "utf8");

    const removed = await uninstallCline(env);
    expect(removed).toBe(false);
    expect(existsSync(hookPath)).toBe(true);
  });
});
