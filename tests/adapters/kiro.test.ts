import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kiroAdapter, uninstallKiro } from "../../src/lib/adapters/kiro.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";

let home: string;
let cwd: string;

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function makeEnv(overrides: Partial<AdapterEnv> = {}): Promise<AdapterEnv> {
  home = await mkdtemp(join(tmpdir(), "bluud-kiro-home-"));
  cwd = await mkdtemp(join(tmpdir(), "bluud-kiro-cwd-"));
  return { cwd, home, global: false, bluudBinary: "/usr/local/bin/bluud", ...overrides };
}

function hookPath(): string {
  return join(cwd, ".kiro", "hooks", "bluud-memory.json");
}

function steeringPath(): string {
  return join(cwd, ".kiro", "steering", "bluud-memory.md");
}

describe("kiroAdapter", () => {
  it("detect() is false when neither .kiro nor ~/.kiro exists", async () => {
    const env = await makeEnv();
    expect(await kiroAdapter.detect(env)).toBe(false);
  });

  it("detect() is true from a project-local .kiro", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });
    expect(await kiroAdapter.detect(env)).toBe(true);
  });

  it("writes a steering document and an agent hook", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });

    const result = await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(true);

    expect(existsSync(steeringPath())).toBe(true);
    expect(existsSync(hookPath())).toBe(true);
  });

  it("the hook is valid JSON in Kiro's when/then shape", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });
    await kiroAdapter.apply(env, { dryRun: false, force: false });

    const hook = JSON.parse(await readFile(hookPath(), "utf8"));
    expect(hook.name).toMatch(/^Bluud:/);
    expect(hook.when.type).toBe("userTriggered");
    // Kiro hooks cannot execute a command — askAgent is the only `then` type,
    // so the integration is necessarily agent-mediated.
    expect(hook.then.type).toBe("askAgent");
    expect(hook.then.prompt).toContain("bluud pull --inject --index");
  });

  it("the steering document is always-included and carries the managed marker", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });
    await kiroAdapter.apply(env, { dryRun: false, force: false });

    const doc = await readFile(steeringPath(), "utf8");
    expect(doc.startsWith("---\ninclusion: always\n---")).toBe(true);
    expect(doc).toContain("<!-- bluud:managed -->");
    expect(doc).toContain("bluud pull --inject --index");
    // Node bodies are loaded on demand, not injected wholesale.
    expect(doc).toContain("bluud pull --inject --id <uuid>");
  });

  it("writes nothing in global scope — Kiro's hook engine is workspace-scoped", async () => {
    const env = await makeEnv({ global: true });
    await mkdir(join(home, ".kiro"), { recursive: true });

    const plan = await kiroAdapter.plan(env);
    expect(plan.detected).toBe(true);
    expect(plan.actions).toEqual([]);

    const result = await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(existsSync(join(home, ".kiro", "hooks"))).toBe(false);
  });

  it("is idempotent: re-applying rewrites nothing", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });

    await kiroAdapter.apply(env, { dryRun: false, force: false });
    const hook = await readFile(hookPath(), "utf8");
    const steering = await readFile(steeringPath(), "utf8");

    await kiroAdapter.apply(env, { dryRun: false, force: false });

    expect(await readFile(hookPath(), "utf8")).toBe(hook);
    expect(await readFile(steeringPath(), "utf8")).toBe(steering);

    const plan = await kiroAdapter.plan(env);
    expect(plan.actions.every((a) => !a.wouldChange)).toBe(true);
  });

  it("never overwrites a user's own hook at the same path", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro", "hooks"), { recursive: true });
    const mine = JSON.stringify({ name: "My hook", when: { type: "userTriggered" } }, null, 2);
    await writeFile(hookPath(), mine, "utf8");

    await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(await readFile(hookPath(), "utf8")).toBe(mine);
  });

  it("identifies ownership by `name`, not by the word 'bluud' appearing in a prompt", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro", "hooks"), { recursive: true });
    // A user hook that merely mentions Bluud must not be treated as Bluud's.
    const mine = JSON.stringify(
      {
        name: "Remind me",
        when: { type: "userTriggered" },
        then: { type: "askAgent", prompt: "run bluud push when done" },
      },
      null,
      2,
    );
    await writeFile(hookPath(), mine, "utf8");

    await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(await readFile(hookPath(), "utf8")).toBe(mine);

    // Uninstall reports true here because Bluud *did* install its steering
    // document (only the hook path was occupied) and has now withdrawn it.
    // What matters is that the user's hook is not among what it removed.
    expect(await uninstallKiro(env)).toBe(true);
    expect(existsSync(steeringPath())).toBe(false);
    expect(await readFile(hookPath(), "utf8")).toBe(mine);
  });

  it("uninstallKiro reports false when only a foreign hook is present", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro", "hooks"), { recursive: true });
    const mine = JSON.stringify({ name: "Remind me", when: { type: "userTriggered" } }, null, 2);
    await writeFile(hookPath(), mine, "utf8");

    expect(await uninstallKiro(env)).toBe(false);
    expect(await readFile(hookPath(), "utf8")).toBe(mine);
  });

  it("treats an unparseable hook file as foreign and leaves it alone", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro", "hooks"), { recursive: true });
    await writeFile(hookPath(), "{ not json", "utf8");

    await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(await readFile(hookPath(), "utf8")).toBe("{ not json");
  });

  it("never overwrites a user-authored steering document", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro", "steering"), { recursive: true });
    const mine = "---\ninclusion: always\n---\n\n# My own memory notes\n";
    await writeFile(steeringPath(), mine, "utf8");

    await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(await readFile(steeringPath(), "utf8")).toBe(mine);
  });

  it("does not write anything in dry-run mode", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });

    await kiroAdapter.apply(env, { dryRun: true, force: false });
    expect(existsSync(hookPath())).toBe(false);
    expect(existsSync(steeringPath())).toBe(false);
  });

  it("does nothing when Kiro is not installed", async () => {
    const env = await makeEnv();
    const result = await kiroAdapter.apply(env, { dryRun: false, force: false });
    expect(result.applied).toBe(false);
    expect(existsSync(hookPath())).toBe(false);
  });

  it("uninstallKiro removes both Bluud artifacts", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });
    await kiroAdapter.apply(env, { dryRun: false, force: false });

    expect(await uninstallKiro(env)).toBe(true);
    expect(existsSync(hookPath())).toBe(false);
    expect(existsSync(steeringPath())).toBe(false);
  });

  it("uninstallKiro reports false when nothing of Bluud's is present", async () => {
    const env = await makeEnv();
    await mkdir(join(cwd, ".kiro"), { recursive: true });
    expect(await uninstallKiro(env)).toBe(false);
  });
});
