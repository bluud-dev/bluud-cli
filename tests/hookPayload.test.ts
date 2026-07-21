import { describe, it, expect } from "vitest";
import { hermesPayloadIsFirstTurn } from "../src/lib/hookPayload.js";

/**
 * The gate that turns Hermes' per-turn `pre_llm_call` event into
 * once-per-session memory injection. Every ambiguous input must resolve to
 * "inject" — see `hookPayload.ts` on why the asymmetry is deliberate.
 */
describe("hermesPayloadIsFirstTurn", () => {
  it("injects on the first turn", () => {
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ is_first_turn: true }))).toBe(true);
  });

  it("suppresses on a later turn", () => {
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ is_first_turn: false }))).toBe(false);
  });

  it("reads the flag from Hermes' `extra` envelope", () => {
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ extra: { is_first_turn: false } }))).toBe(
      false,
    );
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ extra: { is_first_turn: true } }))).toBe(true);
  });

  it("prefers the top-level flag when a build sends both", () => {
    const payload = JSON.stringify({ is_first_turn: true, extra: { is_first_turn: false } });
    expect(hermesPayloadIsFirstTurn(payload)).toBe(true);
  });

  it("injects when there is no payload at all", () => {
    expect(hermesPayloadIsFirstTurn(null)).toBe(true);
  });

  it("injects when the payload is not JSON", () => {
    expect(hermesPayloadIsFirstTurn("not json")).toBe(true);
    expect(hermesPayloadIsFirstTurn("")).toBe(true);
  });

  it("injects when the payload carries no is_first_turn key", () => {
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ hook_event_name: "pre_llm_call" }))).toBe(
      true,
    );
  });

  it("injects when the flag is present but not a boolean", () => {
    // A string "false" must not be read as false — only a real boolean counts.
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ is_first_turn: "false" }))).toBe(true);
    expect(hermesPayloadIsFirstTurn(JSON.stringify({ is_first_turn: null }))).toBe(true);
  });

  it("injects for a JSON scalar or array payload", () => {
    expect(hermesPayloadIsFirstTurn("42")).toBe(true);
    expect(hermesPayloadIsFirstTurn("null")).toBe(true);
    expect(hermesPayloadIsFirstTurn("[]")).toBe(true);
  });
});
