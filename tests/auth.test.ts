import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "node:http";
import { loginWithBrowser, loginWithToken, generatePkcePair } from "../src/lib/auth.js";
import { ApiClient } from "../src/lib/api.js";

vi.mock("../src/lib/browser.js", () => ({
  openBrowser: vi.fn(),
}));

import { openBrowser } from "../src/lib/browser.js";

const mockedOpenBrowser = vi.mocked(openBrowser);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generatePkcePair", () => {
  it("produces a verifier and an S256 challenge", () => {
    const pair = generatePkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it("produces distinct pairs each call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("loginWithBrowser", () => {
  beforeEach(() => {
    mockedOpenBrowser.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges the loopback code for a session", async () => {
    let capturedUrl: string | undefined;
    let capturedRedirectUri: string | undefined;

    mockedOpenBrowser.mockImplementation(async (url: string) => {
      capturedUrl = url;
      const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      const state = new URL(url).searchParams.get("state") ?? "";
      capturedRedirectUri = redirectUri;
      // Simulate the browser navigating to the loopback callback.
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "auth-code-123");
      callback.searchParams.set("state", state);
      get(callback.toString(), () => {});
      return true;
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/cli/token")) {
        return json({
          access_token: "access-xyz",
          refresh_token: "refresh-xyz",
          token_type: "bearer",
        });
      }
      return json({}, 404);
    });

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await loginWithBrowser(api);

    expect(session).toEqual({
      access_token: "access-xyz",
      refresh_token: "refresh-xyz",
      token_type: "bearer",
    });
    expect(capturedUrl).toContain("https://bluud.dev/cli/authorize");
    expect(capturedRedirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const tokenCall = fetchImpl.mock.calls.find((c) => String(c[0]).endsWith("/auth/cli/token"));
    expect(tokenCall).toBeDefined();
    const body = JSON.parse((tokenCall![1] as RequestInit).body as string);
    expect(body.code).toBe("auth-code-123");
    expect(body.redirect_uri).toBe(capturedRedirectUri);
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
  });

  it("calls onBrowserUnavailable and still waits for the callback", async () => {
    const unavailableUrls: string[] = [];

    mockedOpenBrowser.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      const state = new URL(url).searchParams.get("state") ?? "";
      // Even though the browser "could not open", the user opens the URL
      // manually and the callback still arrives.
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "manual-code-456");
      callback.searchParams.set("state", state);
      get(callback.toString(), () => {});
      return false;
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/cli/token")) {
        return json({
          access_token: "access-manual",
          refresh_token: "refresh-manual",
          token_type: "bearer",
        });
      }
      return json({}, 404);
    });

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await loginWithBrowser(api, {
      onBrowserUnavailable: (url) => unavailableUrls.push(url),
    });

    expect(session.access_token).toBe("access-manual");
    expect(unavailableUrls.length).toBe(1);
    expect(unavailableUrls[0]).toContain("https://bluud.dev/cli/authorize");
  });

  it("rejects on state mismatch", async () => {
    mockedOpenBrowser.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      // Send back the wrong state.
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "auth-code-123");
      callback.searchParams.set("state", "wrong-state");
      get(callback.toString(), () => {});
      return true;
    });

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn(async () => json({}, 404)) as unknown as typeof fetch,
    });

    await expect(loginWithBrowser(api)).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("rejects when the callback carries an error", async () => {
    mockedOpenBrowser.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      const state = new URL(url).searchParams.get("state") ?? "";
      const callback = new URL(redirectUri);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("state", state);
      get(callback.toString(), () => {});
      return true;
    });

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn(async () => json({}, 404)) as unknown as typeof fetch,
    });

    await expect(loginWithBrowser(api)).rejects.toMatchObject({
      code: "auth_failed",
      message: expect.stringContaining("access_denied"),
    });
  });

  it("throws immediately on browser-open failure when no callback is provided", async () => {
    mockedOpenBrowser.mockResolvedValue(false);

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: vi.fn(async () => json({}, 404)) as unknown as typeof fetch,
    });

    await expect(loginWithBrowser(api)).rejects.toMatchObject({
      code: "auth_failed",
      message: expect.stringContaining("authenticate manually"),
    });
  });
});

describe("loginWithToken", () => {
  it("returns a PAT session when the account call succeeds", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ id: "u1", email: "dev@bluud.dev" }),
    ) as unknown as typeof fetch;

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl,
    });

    const session = await loginWithToken(api, "bluud_pat_xxx");
    expect(session).toEqual({
      access_token: "bluud_pat_xxx",
      refresh_token: "",
      token_type: "bearer",
    });
  });

  it("rejects with auth_failed when the account call fails", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ detail: "Invalid credentials" }, 401),
    ) as unknown as typeof fetch;

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl,
    });

    await expect(loginWithToken(api, "bluud_pat_bad")).rejects.toMatchObject({
      code: "auth_failed",
      message: "The provided token is invalid.",
    });
  });

  it("rejects with auth_failed when the response lacks an email", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "u1" })) as unknown as typeof fetch;

    const api = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl,
    });

    await expect(loginWithToken(api, "bluud_pat_xxx")).rejects.toMatchObject({
      code: "auth_failed",
      message: "The provided token is invalid.",
    });
  });
});
