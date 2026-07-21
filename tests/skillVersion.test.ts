import { describe, it, expect } from "vitest";
import { stampSkillVersion, readSkillVersion } from "../src/lib/skillVersion.js";

const SAMPLE = `---
name: bluud-memory
description: Persistent project memory.
license: MIT
---

# Bluud memory

Body content here.
`;

describe("stampSkillVersion", () => {
  it("adds metadata.version while preserving existing frontmatter keys and the body", () => {
    const stamped = stampSkillVersion(SAMPLE, "1.2.3");

    expect(stamped).toContain("name: bluud-memory");
    expect(stamped).toContain("description: Persistent project memory.");
    expect(stamped).toContain("license: MIT");
    expect(stamped).toContain("# Bluud memory");
    expect(stamped).toContain("Body content here.");
    expect(readSkillVersion(stamped)).toBe("1.2.3");
  });

  it("merges into an existing metadata block instead of replacing it", () => {
    const withMetadata = `---
name: bluud-memory
description: Persistent project memory.
metadata:
  internal: false
---

Body.
`;
    const stamped = stampSkillVersion(withMetadata, "2.0.0");
    const data = stamped;

    expect(data).toContain("internal: false");
    expect(readSkillVersion(stamped)).toBe("2.0.0");
  });

  it("overwrites a stale version from a previous stamp", () => {
    const once = stampSkillVersion(SAMPLE, "1.0.0");
    const twice = stampSkillVersion(once, "1.0.1");

    expect(readSkillVersion(twice)).toBe("1.0.1");
    expect(twice).not.toContain("1.0.0");
  });

  it("throws on a file with no parseable frontmatter", () => {
    expect(() => stampSkillVersion("# No frontmatter here", "1.0.0")).toThrow(
      /no parseable YAML frontmatter/,
    );
  });
});

describe("readSkillVersion", () => {
  it("returns null when there is no frontmatter", () => {
    expect(readSkillVersion("# No frontmatter here")).toBeNull();
  });

  it("returns null when frontmatter has no metadata.version", () => {
    expect(readSkillVersion(SAMPLE)).toBeNull();
  });

  it("returns null when metadata.version is not a string", () => {
    const malformed = `---
name: bluud-memory
description: x
metadata:
  version: 123
---

Body.
`;
    expect(readSkillVersion(malformed)).toBeNull();
  });
});
