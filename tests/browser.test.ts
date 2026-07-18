import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openBrowser } from "../src/lib/browser.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);

function makeChild(exitCode: number | null = 0, error?: Error) {
  const child = {
    on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      if (event === "error" && error) {
        queueMicrotask(() => handler(error));
      } else if (event === "exit" && exitCode !== undefined) {
        queueMicrotask(() => handler(exitCode));
      }
    }),
  } as unknown as ReturnType<typeof spawn>;
  return child;
}

describe("openBrowser", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    delete process.env.BLUUD_NO_BROWSER;
    delete process.env.CI;
  });

  it("returns false when BLUUD_NO_BROWSER is set", async () => {
    process.env.BLUUD_NO_BROWSER = "1";
    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("returns false in CI", async () => {
    process.env.CI = "true";
    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("returns false for unsupported platforms", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd" });
    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("uses 'open' on darwin", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedSpawn.mockReturnValue(makeChild(0));

    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith("open", ["https://bluud.dev"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("uses xdg-open on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockedSpawn.mockReturnValue(makeChild(0));

    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith("xdg-open", ["https://bluud.dev"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("uses cmd /c start on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockedSpawn.mockReturnValue(makeChild(0));

    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith("cmd", ["/c", "start", "https://bluud.dev"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("returns false when the spawn errors", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedSpawn.mockReturnValue(makeChild(null, new Error("ENOENT")));

    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(false);
  });

  it("returns false when the child exits non-zero", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedSpawn.mockReturnValue(makeChild(1));

    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(false);
  });

  it("resolves true after the timeout if the child has not exited", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const child = {
      on: vi.fn(),
    } as unknown as ReturnType<typeof spawn>;
    mockedSpawn.mockReturnValue(child);

    const result = await openBrowser("https://bluud.dev");
    expect(result).toBe(true);
  });
});
