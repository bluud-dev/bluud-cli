import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn(),
}));

import { determineAgent } from "@vercel/detect-agent";
import {
  detectRunningAgent,
  isRunningInAgent,
  resetRunningAgentCache,
} from "../src/lib/runningAgent.js";

const mockedDetermineAgent = vi.mocked(determineAgent);

/**
 * Environment variables the detector (or Bluud's refinement of it) reads.
 * Cleared before every test so a real agent session running this suite — which
 * is entirely plausible, since Bluud is built by agents — cannot leak its own
 * variables into the assertions.
 */
const AGENT_ENV_KEYS = [
  "BLUUD_AGENT",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_EXTENSION_HOST_ROLE",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(AGENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of AGENT_ENV_KEYS) delete process.env[key];
  resetRunningAgentCache();
  mockedDetermineAgent.mockReset();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRunningAgentCache();
});

function agentResult(name: string) {
  return { isAgent: true as const, agent: { name } };
}

const noAgent = { isAgent: false as const, agent: undefined };

describe("detectRunningAgent", () => {
  it("reports no agent for a plain interactive shell", async () => {
    mockedDetermineAgent.mockResolvedValue(noAgent);

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: false, name: null });
    await expect(isRunningInAgent()).resolves.toBe(false);
  });

  it("reports the agent name when one is driving the process", async () => {
    mockedDetermineAgent.mockResolvedValue(agentResult("claude"));

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: true, name: "claude" });
  });

  it.each(["codex", "gemini", "devin", "replit", "antigravity"])(
    "recognises %s as a driving agent",
    async (name) => {
      mockedDetermineAgent.mockResolvedValue(agentResult(name));
      await expect(isRunningInAgent()).resolves.toBe(true);
    },
  );

  it("caches the result so repeated checks do not re-probe", async () => {
    mockedDetermineAgent.mockResolvedValue(agentResult("codex"));

    await detectRunningAgent();
    await detectRunningAgent();
    await isRunningInAgent();

    expect(mockedDetermineAgent).toHaveBeenCalledTimes(1);
  });

  it("degrades to 'interactive' when the detector throws", async () => {
    // Detection decides prompt suppression only; a failure inside the
    // third-party detector must never take down the user's command.
    mockedDetermineAgent.mockRejectedValue(new Error("detector exploded"));

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: false, name: null });
  });
});

describe("detectRunningAgent — Cursor refinement", () => {
  it("ignores a bare CURSOR_TRACE_ID, which Cursor also sets in its human terminal", async () => {
    // Without this refinement a developer typing `npx bluud` in Cursor's
    // integrated terminal would silently lose every prompt.
    process.env.CURSOR_TRACE_ID = "trace-abc";
    mockedDetermineAgent.mockResolvedValue(agentResult("cursor"));

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: false, name: null });
  });

  it("honours CURSOR_AGENT as a strong signal", async () => {
    process.env.CURSOR_AGENT = "1";
    mockedDetermineAgent.mockResolvedValue(agentResult("cursor"));

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: true, name: "cursor" });
  });

  it("honours CURSOR_EXTENSION_HOST_ROLE=agent-exec as a strong signal", async () => {
    process.env.CURSOR_EXTENSION_HOST_ROLE = "agent-exec";
    mockedDetermineAgent.mockResolvedValue(agentResult("cursor-cli"));

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: true, name: "cursor-cli" });
  });

  it("applies the refinement only to Cursor, not to other agents", async () => {
    // A whitespace-only CURSOR_AGENT is not a strong signal, but it must not
    // suppress an unrelated agent either.
    process.env.CURSOR_AGENT = "   ";
    mockedDetermineAgent.mockResolvedValue(agentResult("claude"));

    await expect(detectRunningAgent()).resolves.toEqual({ isAgent: true, name: "claude" });
  });
});

describe("detectRunningAgent — BLUUD_AGENT override", () => {
  it.each(["1", "true", "TRUE"])("forces agent mode with BLUUD_AGENT=%s", async (value) => {
    process.env.BLUUD_AGENT = value;
    mockedDetermineAgent.mockResolvedValue(noAgent);

    await expect(isRunningInAgent()).resolves.toBe(true);
    // The override short-circuits detection entirely.
    expect(mockedDetermineAgent).not.toHaveBeenCalled();
  });

  it.each(["0", "false"])("forces interactive mode with BLUUD_AGENT=%s", async (value) => {
    // The escape hatch for a terminal carrying a stray agent variable.
    process.env.BLUUD_AGENT = value;
    mockedDetermineAgent.mockResolvedValue(agentResult("claude"));

    await expect(isRunningInAgent()).resolves.toBe(false);
    expect(mockedDetermineAgent).not.toHaveBeenCalled();
  });

  it("falls through to detection for an unrecognised override value", async () => {
    process.env.BLUUD_AGENT = "maybe";
    mockedDetermineAgent.mockResolvedValue(agentResult("codex"));

    await expect(isRunningInAgent()).resolves.toBe(true);
    expect(mockedDetermineAgent).toHaveBeenCalled();
  });

  it("falls through to detection for an empty override value", async () => {
    process.env.BLUUD_AGENT = "";
    mockedDetermineAgent.mockResolvedValue(noAgent);

    await expect(isRunningInAgent()).resolves.toBe(false);
    expect(mockedDetermineAgent).toHaveBeenCalled();
  });
});
