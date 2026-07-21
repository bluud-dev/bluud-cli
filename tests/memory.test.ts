import { describe, it, expect } from "vitest";
import { CliError } from "../src/lib/error.js";
import {
  formatQuotaWarning,
  isQuotaWarning,
  renderClineHookOutput,
  renderGeminiHookOutput,
  renderMemoryIndex,
  renderMemoryNodes,
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

function makeNode(
  overrides: Partial<MemoryTree["nodes"][number]> = {},
): MemoryTree["nodes"][number] {
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
    const message = formatQuotaWarning(
      makeTree({ total_size_bytes: 1000, quota_usage_ratio: 0.95 }),
    );
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
    expect(() => validateDiffOperations({ operations: [{ op: "merge", id: "uuid" }] })).toThrow(
      'expected "create", "update", or "delete"',
    );
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

describe("renderMemoryIndex", () => {
  it("renders an empty tree", () => {
    const output = renderMemoryIndex(makeTree());
    expect(output).toContain("# Bluud project memory (index)");
    expect(output).toContain("No memory has been recorded for this project yet");
  });

  it("includes id, breadcrumb, updated_at, and description but never body", () => {
    const output = renderMemoryIndex(
      makeTree({
        nodes: [
          makeNode({
            id: "root-1",
            title: "Architecture",
            description: "Core rules",
            body: "Full body text nobody should see in the index.",
            updated_at: "2026-03-05T12:30:00Z",
            depth: 0,
          }),
        ],
      }),
    );

    expect(output).toContain("- Architecture");
    expect(output).toContain("id: root-1");
    expect(output).toContain("updated: 2026-03-05");
    expect(output).toContain("Core rules");
    expect(output).not.toContain("Full body text");
  });

  it("prefixes each entry's title with its ancestors' titles, root-first", () => {
    const output = renderMemoryIndex(
      makeTree({
        nodes: [
          makeNode({ id: "a", title: "Architecture", parent_id: null, depth: 0 }),
          makeNode({ id: "b", title: "Boundaries", parent_id: "a", depth: 1 }),
          makeNode({ id: "c", title: "Server/Client", parent_id: "b", depth: 2 }),
        ],
      }),
    );

    expect(output).toContain("- Architecture");
    expect(output).toContain("- Architecture > Boundaries");
    expect(output).toContain("- Architecture > Boundaries > Server/Client");
  });

  it("omits an empty description", () => {
    const output = renderMemoryIndex(
      makeTree({ nodes: [makeNode({ title: "Minimal", description: "" })] }),
    );
    expect(output).toContain("- Minimal");
    expect(output).not.toMatch(/- Minimal\n {2}\n/);
  });

  it("ends with a self-documenting hint naming the repeatable --id follow-up", () => {
    const output = renderMemoryIndex(makeTree({ nodes: [makeNode({ title: "Architecture" })] }));
    expect(output).toContain(
      "To load one or more of these in full, run: bluud pull --inject --id <uuid> " +
        "(repeat --id for more than one).",
    );
  });
});

describe("renderMemoryNodes", () => {
  it("renders the requested node's full content (title, description, body)", () => {
    const tree = makeTree({
      nodes: [
        makeNode({
          id: "a",
          title: "Rule",
          description: "A rule",
          body: "Full details.",
          depth: 0,
        }),
      ],
    });

    const output = renderMemoryNodes(tree, ["a"]);

    expect(output).toContain("## Rule");
    expect(output).toContain("A rule");
    expect(output).toContain("Full details.");
  });

  it("prefixes a selected node with an ancestor-title breadcrumb, titles only", () => {
    const tree = makeTree({
      nodes: [
        makeNode({
          id: "parent",
          title: "Architecture",
          description: "Parent description that must not leak into the breadcrumb",
          parent_id: null,
          depth: 0,
        }),
        makeNode({ id: "child", title: "Boundaries", parent_id: "parent", depth: 1 }),
      ],
    });

    const output = renderMemoryNodes(tree, ["child"]);

    expect(output).toContain("_Architecture_");
    expect(output).toContain("## Boundaries");
    expect(output).not.toContain("Parent description that must not leak");
  });

  it("omits the breadcrumb line entirely for a root node", () => {
    const tree = makeTree({ nodes: [makeNode({ id: "root", title: "Root", depth: 0 })] });
    const output = renderMemoryNodes(tree, ["root"]);
    expect(output).not.toContain("_");
  });

  it("renders multiple requested nodes in the order ids were given, not tree order", () => {
    const tree = makeTree({
      nodes: [
        makeNode({ id: "a", title: "First", depth: 0 }),
        makeNode({ id: "b", title: "Second", depth: 0 }),
      ],
    });

    const output = renderMemoryNodes(tree, ["b", "a"]);

    expect(output.indexOf("## Second")).toBeLessThan(output.indexOf("## First"));
  });

  it("throws CliError naming the id when a requested node does not exist", () => {
    const tree = makeTree({ nodes: [makeNode({ id: "a", title: "Only node" })] });

    expect(() => renderMemoryNodes(tree, ["missing-id"])).toThrow(CliError);
    expect(() => renderMemoryNodes(tree, ["missing-id"])).toThrow("missing-id");
  });
});

describe("renderGeminiHookOutput", () => {
  it("emits only a single JSON object with hookSpecificOutput.additionalContext", () => {
    const tree = makeTree({
      nodes: [makeNode({ title: "Rule", description: "A rule", body: "Details." })],
    });

    const output = renderGeminiHookOutput(renderMemoryTree(tree));

    // Gemini CLI requires stdout to be *only* JSON — no trailing newline noise
    // or stray text is embedded.
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Rule");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Details.");
  });

  it("wraps whatever content it's given — index or full tree — since format and content selection are orthogonal", () => {
    const tree = makeTree({
      nodes: [makeNode({ id: "a", title: "Rule", description: "A rule", body: "Details." })],
    });

    const output = renderGeminiHookOutput(renderMemoryIndex(tree));

    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("# Bluud project memory (index)");
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain("Details.");
  });
});

describe("renderClineHookOutput", () => {
  it("emits only a single JSON object with contextModification", () => {
    const tree = makeTree({
      nodes: [makeNode({ title: "Decision", description: "A decision", body: "Because X." })],
    });

    const output = renderClineHookOutput(renderMemoryTree(tree));

    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual(["contextModification"]);
    expect(parsed.contextModification).toContain("## Decision");
    expect(parsed.contextModification).toContain("Because X.");
  });

  it("wraps whatever content it's given — index or full tree — since format and content selection are orthogonal", () => {
    const tree = makeTree({
      nodes: [makeNode({ id: "a", title: "Decision", description: "A decision", body: "Because X." })],
    });

    const output = renderClineHookOutput(renderMemoryIndex(tree));

    const parsed = JSON.parse(output);
    expect(parsed.contextModification).toContain("# Bluud project memory (index)");
    expect(parsed.contextModification).not.toContain("Because X.");
  });
});
