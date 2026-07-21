import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { piAdapter, uninstallPi } from "../../src/lib/adapters/pi.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-pi-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-pi-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

function projectExtension(): string {
  return join(cwd, ".pi", "extensions", "bluud", "index.ts");
}

function globalExtension(): string {
  return join(home, ".pi", "agent", "extensions", "bluud", "index.ts");
}

describe("piAdapter", () => {
  it("detect() is false when neither .pi nor ~/.pi exists", async () => {
    const env = await makeEnv();
    expect(await piAdapter.detect(env)).toBe(false);
  });

  it("detect() is true from a project-local .pi", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    expect(await piAdapter.detect(env)).toBe(true);
  });

  it("detect() is true from a user-level ~/.pi", async () => {
    const env = await makeEnv();
    await mkdir(join(home, ".pi"), { recursive: true });
    expect(await piAdapter.detect(env)).toBe(true);
  });

  it("writes an extension module — Pi has no hooks config to merge", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });

    const result = await piAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    const source = await readFile(projectExtension(), "utf8");
    expect(source).toContain("// bluud:managed");
    // The three lifecycle events it takes to inject exactly once.
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("before_agent_start"');
    expect(source).toContain('pi.on("context"');
  });

  it("substitutes the binary as a JSON literal, so a Windows path survives", async () => {
    const env = await makeEnv({ bluudBinary: "C:\\Users\\me\\bluud.exe" });
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await piAdapter.apply(env, { dryRun: false, force: false });

    const source = await readFile(projectExtension(), "utf8");
    // Backslashes must arrive escaped — a naive quote-wrap would emit `\U`,
    // an invalid escape that would not compile.
    expect(source).toContain('const BLUUD_BINARY: string = "C:\\\\Users\\\\me\\\\bluud.exe";');
    expect(source).not.toContain("@BLUUD_BINARY@");
  });

  it("pulls the index, not the full tree", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await piAdapter.apply(env, { dryRun: false, force: false });

    const source = await readFile(projectExtension(), "utf8");
    expect(source).toContain('["pull", "--inject", "--index"]');
  });

  it("writes under the agent/ segment in global scope", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".pi"), { recursive: true });

    await piAdapter.apply(env, { dryRun: false, force: false });

    expect(existsSync(globalExtension())).toBe(true);
    expect(existsSync(projectExtension())).toBe(false);
  });

  it("normalizes to LF so the emitted TypeScript never carries CRLF", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await piAdapter.apply(env, { dryRun: false, force: false });

    expect(await readFile(projectExtension(), "utf8")).not.toContain("\r");
  });

  it("is idempotent: re-applying does not rewrite the file", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await piAdapter.apply(env, { dryRun: false, force: false });
    const first = await readFile(projectExtension(), "utf8");
    await piAdapter.apply(env, { dryRun: false, force: false });

    expect(await readFile(projectExtension(), "utf8")).toBe(first);
  });

  it("never overwrites a user-authored extension lacking the managed marker", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const dir = join(cwd, ".pi", "extensions", "bluud");
    await mkdir(dir, { recursive: true });
    const mine = "export default function (pi: any) { /* mine */ }\n";
    await writeFile(join(dir, "index.ts"), mine, "utf8");

    const plan = await piAdapter.plan(env);
    expect(plan.actions[0].wouldChange).toBe(false);
    expect(plan.actions[0].description).toContain("skipped");

    const result = await piAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(await readFile(join(dir, "index.ts"), "utf8")).toBe(mine);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });

    await piAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(projectExtension())).toBe(false);
  });

  it("does nothing when Pi is not installed", async () => {
    const env = await makeEnv();
    const result = await piAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(existsSync(projectExtension())).toBe(false);
  });

  it("uninstallPi removes the extension and its now-empty directory", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await piAdapter.apply(env, { dryRun: false, force: false });

    expect(await uninstallPi(env)).toBe(true);
    expect(existsSync(projectExtension())).toBe(false);
    expect(existsSync(join(cwd, ".pi", "extensions", "bluud"))).toBe(false);
    // Pi's own extensions root is not Bluud's to remove.
    expect(existsSync(join(cwd, ".pi", "extensions"))).toBe(true);
  });

  it("uninstallPi refuses to remove a user-authored extension", async () => {
    const env = await makeEnv();
    const dir = join(cwd, ".pi", "extensions", "bluud");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), "export default function () {}\n", "utf8");

    expect(await uninstallPi(env)).toBe(false);
    expect(existsSync(join(dir, "index.ts"))).toBe(true);
  });
});
