import { describe, it, expect } from "vitest";
import { parseArgs, getFlagString, getFlagBoolean, getFlagArray } from "../src/lib/args.js";

describe("args", () => {
  it("parses command and positionals", () => {
    const parsed = parseArgs(["push", "file.md"]);
    expect(parsed.command).toBe("push");
    expect(parsed.positionals).toEqual(["file.md"]);
  });

  it("parses boolean short and long flags", () => {
    const parsed = parseArgs(["--yes", "-g"]);
    expect(getFlagBoolean(parsed.flags, "yes")).toBe(true);
    expect(getFlagBoolean(parsed.flags, "g")).toBe(true);
  });

  it("parses string flags", () => {
    const parsed = parseArgs(["--token", "bluud_pat_xxx"]);
    expect(getFlagString(parsed.flags, "token")).toBe("bluud_pat_xxx");
  });

  it("collects repeated flags into arrays", () => {
    const parsed = parseArgs(["-a", "claude-code", "-a", "cursor"]);
    expect(getFlagArray(parsed.flags, "a")).toEqual(["claude-code", "cursor"]);
  });

  it("respects the bare -- terminator", () => {
    const parsed = parseArgs(["push", "--", "--not-a-flag"]);
    expect(parsed.positionals).toEqual(["--not-a-flag"]);
  });
});
