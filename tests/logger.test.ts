import { describe, it, expect } from "vitest";
import { createLogger, resolveLogLevel } from "../src/lib/logger.js";

describe("resolveLogLevel", () => {
  it("quiet wins over everything", () => {
    expect(resolveLogLevel({ quiet: true, verbose: true, env: "debug" })).toBe("error");
  });

  it("verbose/debug maps to debug", () => {
    expect(resolveLogLevel({ verbose: true })).toBe("debug");
    expect(resolveLogLevel({ debug: true })).toBe("debug");
  });

  it("honors a valid BLUUD_LOG env value", () => {
    expect(resolveLogLevel({ env: "warn" })).toBe("warn");
    expect(resolveLogLevel({ env: "SILENT" })).toBe("silent");
  });

  it("ignores an invalid env value and defaults to info", () => {
    expect(resolveLogLevel({ env: "chatty" })).toBe("info");
    expect(resolveLogLevel({})).toBe("info");
  });
});

describe("createLogger", () => {
  function capturing(level: Parameters<typeof createLogger>[0]["level"]) {
    const lines: string[] = [];
    const log = createLogger({ level, sink: (l) => lines.push(l), noColor: true });
    return { log, lines };
  }

  it("gates messages below the threshold", () => {
    const { log, lines } = capturing("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toEqual(["warning: w", "error: e"]);
  });

  it("emits info and success at info level", () => {
    const { log, lines } = capturing("info");
    log.info("hello");
    log.success("done");
    expect(lines).toEqual(["hello", "✓ done"]);
  });

  it("silent suppresses everything including errors", () => {
    const { log, lines } = capturing("silent");
    log.error("boom");
    expect(lines).toEqual([]);
  });

  it("isDebug reflects the threshold", () => {
    expect(capturing("debug").log.isDebug()).toBe(true);
    expect(capturing("info").log.isDebug()).toBe(false);
  });
});
