import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pullCommand } from "../src/commands/pull.js";
import { saveProjectToken } from "../src/lib/config.js";
import { computeIdentity } from "../src/lib/identity.js";
import { ApiClient } from "../src/lib/api.js";
import type { CommandContext } from "../src/commands/index.js";
import type { MemoryTree } from "../src/types.js";

let originalConfigDir: string | undefined;

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    api: new ApiClient({ baseUrl: "http://localhost:1", fetchImpl: vi.fn() as unknown as typeof fetch }),
    out: {
      write: vi.fn(),
      writeLine: vi.fn(),
      error: vi.fn(),
      errorLine: vi.fn(),
    },
    log: {
      level: "info",
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      isDebug: () => false,
    },
    cwd: "/tmp/project",
    args: [],
    flags: {},
    nonInteractive: false,
    ...overrides,
  };
}

function makeTree(overrides: Partial<MemoryTree> = {}): MemoryTree {
  return {
    nodes: [],
    total_size_bytes: 0,
    quota_usage_ratio: 0,
    ...overrides,
  };
}

async function setupProjectToken(projectDir: string): Promise<string> {
  const identity = await computeIdentity(projectDir);
  await saveProjectToken(identity.projectId, "bluud_pt_test_token");
  return identity.projectId;
}

describe("pullCommand", () => {
  let tempConfig: string;
  let tempProject: string;

  beforeEach(async () => {
    tempConfig = await mkdtemp(join(tmpdir(), "bluud-pull-test-"));
    tempProject = await mkdtemp(join(tmpdir(), "bluud-pull-project-"));
    originalConfigDir = process.env.BLUUD_CONFIG_DIR;
    process.env.BLUUD_CONFIG_DIR = tempConfig;
  });

  afterEach(async () => {
    await rm(tempConfig, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.BLUUD_CONFIG_DIR;
    } else {
      process.env.BLUUD_CONFIG_DIR = originalConfigDir;
    }
  });

  it("injects a rendered memory tree", async () => {
    const projectId = await setupProjectToken(tempProject);
    const tree = makeTree({
      nodes: [
        {
          id: "node-1",
          project_id: projectId,
          parent_id: null,
          title: "Architecture",
          description: "Core architecture decisions",
          body: "Use hexagonal architecture.",
          size_bytes: 100,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          depth: 0,
        },
        {
          id: "node-2",
          project_id: projectId,
          parent_id: "node-1",
          title: "Database",
          description: "Database conventions",
          body: "Prefer UUID primary keys.",
          size_bytes: 80,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          depth: 1,
        },
      ],
      total_size_bytes: 180,
      quota_usage_ratio: 0.05,
    });

    const pullMemory = vi.fn().mockResolvedValue(tree);
    const ctx = makeContext({
      cwd: tempProject,
      flags: { inject: true },
      api: { pullMemory } as unknown as ApiClient,
    });

    const code = await pullCommand.run(ctx);

    expect(code).toBe(0);
    expect(pullMemory).toHaveBeenCalledWith(projectId, "bluud_pt_test_token");
    const written = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join("\n");
    expect(written).toContain("# Bluud project memory");
    expect(written).toContain("## Architecture");
    expect(written).toContain("Core architecture decisions");
    expect(written).toContain("Use hexagonal architecture.");
    expect(written).toContain("### Database");
    expect(written).toContain("Prefer UUID primary keys.");
  });

  it("prints an empty-state message when no memory exists", async () => {
    await setupProjectToken(tempProject);
    const tree = makeTree();
    const pullMemory = vi.fn().mockResolvedValue(tree);
    const ctx = makeContext({
      cwd: tempProject,
      flags: { inject: true },
      api: { pullMemory } as unknown as ApiClient,
    });

    const code = await pullCommand.run(ctx);

    expect(code).toBe(0);
    const written = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join("\n");
    expect(written).toContain("No memory has been recorded for this project yet");
  });

  it("prints a summary and warns when quota usage is high", async () => {
    await setupProjectToken(tempProject);
    const tree = makeTree({
      nodes: [
        {
          id: "node-1",
          project_id: "project-id",
          parent_id: null,
          title: "Conventions",
          description: "Coding conventions",
          body: "",
          size_bytes: 900,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          depth: 0,
        },
      ],
      total_size_bytes: 900,
      quota_usage_ratio: 0.95,
    });

    const pullMemory = vi.fn().mockResolvedValue(tree);
    const ctx = makeContext({
      cwd: tempProject,
      api: { pullMemory } as unknown as ApiClient,
    });

    const code = await pullCommand.run(ctx);

    expect(code).toBe(0);
    expect(ctx.out.writeLine).toHaveBeenCalledWith("Pulled 1 node(s), 900 bytes.");
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Project memory is at 95% of the storage quota"),
    );
  });

  it("outputs raw json with --json", async () => {
    await setupProjectToken(tempProject);
    const tree = makeTree({
      nodes: [],
      total_size_bytes: 0,
      quota_usage_ratio: 0,
    });
    const pullMemory = vi.fn().mockResolvedValue(tree);
    const ctx = makeContext({
      cwd: tempProject,
      flags: { json: true },
      api: { pullMemory } as unknown as ApiClient,
    });

    const code = await pullCommand.run(ctx);

    expect(code).toBe(0);
    const written = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(written)).toEqual(tree);
  });

  it("throws auth_required when no project token exists", async () => {
    const ctx = makeContext({ cwd: tempProject });
    await expect(pullCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });
});
