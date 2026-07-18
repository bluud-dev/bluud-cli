import { describe, it, expect } from "vitest";
import { CliError } from "../src/lib/error.js";
import {
  formatQuotaWarning,
  isQuotaWarning,
  renderMemoryTree,
  validateDiffOperations,
} from "../src/lib/memory.js";
import type { MemoryTree } from "../src/types.js";

function makeTree(overrides: Partial<MemoryTree> = {}): MemoryTree {
  return {
    nodes: [],
    total_size_bytes: 0,
    quota_usage_ratio: 0,
    ...overrides,
  };
}

function makeNode(overrides: Partial<MemoryTree["nodes"][number]> = {}): MemoryTree["nodes"][number] {
  return {
    id: "node-1",
    project_id: "project-id",
    parent_id: null,
    title: "Node",
    description: "Description",
    body: "Body.",
    size_bytes: 10,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    depth: 0,
    ...overrides,
  };
}

describe("renderMemoryTree", () => {
  it("renders an empty tree", () => {
    const output = renderMemoryTree(makeTree());
    expect(output).toContain("# Bluud project memory");
    expect(output).toContain("No memory has been recorded for this project yet");
  });

  it("renders nodes with heading depth based on tree depth", () => {
    const output = renderMemoryTree(
      makeTree({
        nodes: [
          makeNode({ title: "Root", depth: 0 }),
          makeNode({ title: "Child", depth: 1, parent_id: "node-1" }),
          makeNode({ title: "Grandchild", depth: 2, parent_id: "node-2" }),
        ],
      }),
    );

    expect(output).toContain("## Root");
    expect(output).toContain("### Child");
    expect(output).toContain("#### Grandchild");
  });

  it("caps headings at h6", () => {
    const output = renderMemoryTree(
      makeTree({
        nodes: [makeNode({ title: "Deep", depth: 10 })],
      }),
    );

    expect(output).toContain("###### Deep");
    expect(output).not.toContain("####### Deep");
  });

  it("omits empty description and body", () => {
    const output = renderMemoryTree(
      makeTree({
        nodes: [makeNode({ title: "Minimal", description: "", body: "" })],
      }),
    );

    expect(output).toContain("## Minimal");
    expect(output).not.toContain("Description");
    expect(output).not.toContain("Body.");
  });
});

describe("isQuotaWarning", () => {
  it("returns true at the threshold", () => {
    expect(isQuotaWarning(makeTree({ quota_usage_ratio: 0.9 }))).toBe(true);
  });

  it("returns false below the threshold", () => {
    expect(isQuotaWarning(makeTree({ quota_usage_ratio: 0.89 }))).toBe(false);
  });
});

describe("formatQuotaWarning", () => {
  it("includes the usage ratio and byte count", () => {
    const message = formatQuotaWarning(makeTree({ total_size_bytes: 1000, quota_usage_ratio: 0.95 }));
    expect(message).toContain("95%");
    expect(message).toContain("1000 bytes");
  });
});

describe("validateDiffOperations", () => {
  it("accepts a valid create without id", () => {
    const ops = validateDiffOperations({
      operations: [{ op: "create", document: "---\ntitle: X\ndescription: Y\n---\nZ." }],
    });
    expect(ops).toEqual([{ op: "create", document: "---\ntitle: X\ndescription: Y\n---\nZ." }]);
  });

  it("accepts a valid create with id", () => {
    const ops = validateDiffOperations({
      operations: [{ op: "create", id: "uuid", document: "doc" }],
    });
    expect(ops).toEqual([{ op: "create", id: "uuid", document: "doc" }]);
  });

  it("accepts a valid update", () => {
    const ops = validateDiffOperations({
      operations: [{ op: "update", id: "uuid", document: "doc" }],
    });
    expect(ops).toEqual([{ op: "update", id: "uuid", document: "doc" }]);
  });

  it("accepts a valid delete", () => {
    const ops = validateDiffOperations({
      operations: [{ op: "delete", id: "uuid" }],
    });
    expect(ops).toEqual([{ op: "delete", id: "uuid" }]);
  });

  it("rejects a missing operations array", () => {
    expect(() => validateDiffOperations({})).toThrow(CliError);
    expect(() => validateDiffOperations({})).toThrow("'operations' array");
  });

  it("rejects an unknown op", () => {
    expect(() =>
      validateDiffOperations({ operations: [{ op: "merge", id: "uuid" }] }),
    ).toThrow('expected "create", "update", or "delete"');
  });

  it("rejects create without document", () => {
    expect(() => validateDiffOperations({ operations: [{ op: "create" }] })).toThrow(
      "requires a non-empty 'document'",
    );
  });

  it("rejects update without id", () => {
    expect(() =>
      validateDiffOperations({ operations: [{ op: "update", document: "doc" }] }),
    ).toThrow("requires a non-empty 'id'");
  });

  it("rejects delete without id", () => {
    expect(() => validateDiffOperations({ operations: [{ op: "delete" }] })).toThrow(
      "requires a non-empty 'id'",
    );
  });

  it("rejects an invalid create id", () => {
    expect(() =>
      validateDiffOperations({ operations: [{ op: "create", id: "", document: "doc" }] }),
    ).toThrow("invalid 'id'");
  });
});
