import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pushCommand } from "../src/commands/push.js";
import { saveProjectToken } from "../src/lib/config.js";
import { computeIdentity } from "../src/lib/identity.js";
import { ApiClient } from "../src/lib/api.js";
import { CliError } from "../src/lib/error.js";
import type { CommandContext } from "../src/commands/index.js";
import type { MemoryPushResult } from "../src/types.js";

let originalConfigDir: string | undefined;

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    api: new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    }),
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

function makeResult(overrides: Partial<MemoryPushResult> = {}): MemoryPushResult {
  return {
    nodes: [],
    total_size_bytes: 0,
    quota_usage_ratio: 0,
    read_only: false,
    ...overrides,
  };
}

async function setupProjectToken(projectDir: string): Promise<string> {
  const identity = await computeIdentity(projectDir);
  await saveProjectToken(identity.projectId, "bluud_pt_test_token");
  return identity.projectId;
}

function createStdin(data: string): NodeJS.ReadStream {
  return Readable.from([Buffer.from(data)]) as unknown as NodeJS.ReadStream;
}

describe("pushCommand", () => {
  let tempConfig: string;
  let tempProject: string;

  beforeEach(async () => {
    tempConfig = await mkdtemp(join(tmpdir(), "bluud-push-test-"));
    tempProject = await mkdtemp(join(tmpdir(), "bluud-push-project-"));
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

  it("pushes a valid diff and prints a summary", async () => {
    const projectId = await setupProjectToken(tempProject);
    const result = makeResult({ total_size_bytes: 250 });
    const pushMemory = vi.fn().mockResolvedValue(result);

    const diff = {
      operations: [
        {
          op: "create",
          document: "---\ntitle: New Node\ndescription: A new node\n---\nBody.",
        },
        {
          op: "update",
          id: "node-1",
          document: "---\ntitle: Updated Node\ndescription: Updated\n---\nUpdated body.",
        },
        {
          op: "delete",
          id: "node-2",
        },
      ],
    };

    const ctx = makeContext({
      cwd: tempProject,
      api: { pushMemory } as unknown as ApiClient,
      stdin: createStdin(JSON.stringify(diff)),
    });

    const code = await pushCommand.run(ctx);

    expect(code).toBe(0);
    expect(pushMemory).toHaveBeenCalledWith(projectId, "bluud_pt_test_token", diff.operations);
    expect(ctx.out.writeLine).toHaveBeenCalledWith("Pushed 3 operation(s). Total size: 250 bytes.");
  });

  it("warns when the push causes a quota lock", async () => {
    await setupProjectToken(tempProject);
    const result = makeResult({ total_size_bytes: 1000, read_only: true });
    const pushMemory = vi.fn().mockResolvedValue(result);
    const ctx = makeContext({
      cwd: tempProject,
      api: { pushMemory } as unknown as ApiClient,
      stdin: createStdin(
        JSON.stringify({ operations: [{ op: "create", document: "---\ntitle: X\ndescription: Y\n---\nZ." }] }),
      ),
    });

    const code = await pushCommand.run(ctx);

    expect(code).toBe(0);
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      expect.stringContaining("This push exceeded the quota"),
    );
  });

  it("handles 423 Locked gracefully", async () => {
    await setupProjectToken(tempProject);
    const pushMemory = vi.fn().mockRejectedValue(
      new CliError("Project is read-only", { code: "project_locked" }),
    );
    const ctx = makeContext({
      cwd: tempProject,
      api: { pushMemory } as unknown as ApiClient,
      stdin: createStdin(JSON.stringify({ operations: [{ op: "delete", id: "node-1" }] })),
    });

    const code = await pushCommand.run(ctx);

    expect(code).toBe(0);
    expect(ctx.out.writeLine).toHaveBeenCalledWith(
      expect.stringContaining("Project memory is read-only"),
    );
  });

  it("outputs raw json with --json", async () => {
    await setupProjectToken(tempProject);
    const result = makeResult({ total_size_bytes: 100 });
    const pushMemory = vi.fn().mockResolvedValue(result);
    const ctx = makeContext({
      cwd: tempProject,
      flags: { json: true },
      api: { pushMemory } as unknown as ApiClient,
      stdin: createStdin(JSON.stringify({ operations: [{ op: "delete", id: "node-1" }] })),
    });

    const code = await pushCommand.run(ctx);

    expect(code).toBe(0);
    const written = (ctx.out.writeLine as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(written)).toEqual(result);
  });

  it("throws api_error when stdin is not valid json", async () => {
    await setupProjectToken(tempProject);
    const ctx = makeContext({ cwd: tempProject, stdin: createStdin("not-json") });

    await expect(pushCommand.run(ctx)).rejects.toMatchObject({ code: "api_error" });
  });

  it("throws api_error when operations array is missing", async () => {
    await setupProjectToken(tempProject);
    const ctx = makeContext({ cwd: tempProject, stdin: createStdin(JSON.stringify({})) });

    await expect(pushCommand.run(ctx)).rejects.toMatchObject({ code: "api_error" });
  });

  it("throws api_error for an unknown op", async () => {
    await setupProjectToken(tempProject);
    const ctx = makeContext({
      cwd: tempProject,
      stdin: createStdin(JSON.stringify({ operations: [{ op: "merge", id: "node-1" }] })),
    });

    await expect(pushCommand.run(ctx)).rejects.toMatchObject({ code: "api_error" });
  });

  it("throws api_error when create/update lacks a document", async () => {
    await setupProjectToken(tempProject);
    const ctx = makeContext({
      cwd: tempProject,
      stdin: createStdin(JSON.stringify({ operations: [{ op: "create" }] })),
    });

    await expect(pushCommand.run(ctx)).rejects.toMatchObject({ code: "api_error" });
  });

  it("throws api_error when update/delete lacks an id", async () => {
    await setupProjectToken(tempProject);
    const ctx = makeContext({
      cwd: tempProject,
      stdin: createStdin(
        JSON.stringify({
          operations: [{ op: "update", document: "---\ntitle: X\ndescription: Y\n---\nZ." }],
        }),
      ),
    });

    await expect(pushCommand.run(ctx)).rejects.toMatchObject({ code: "api_error" });
  });

  it("throws auth_required when no project token exists", async () => {
    const ctx = makeContext({
      cwd: tempProject,
      stdin: createStdin(JSON.stringify({ operations: [] })),
    });

    await expect(pushCommand.run(ctx)).rejects.toMatchObject({ code: "auth_required" });
  });
});
