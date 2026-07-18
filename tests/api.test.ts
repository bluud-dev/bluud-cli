import { describe, it, expect, vi } from "vitest";
import { ApiClient } from "../src/lib/api.js";
import { CliError } from "../src/lib/error.js";
import type { AuthSession } from "../src/types.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SESSION: AuthSession = {
  access_token: "old-access",
  refresh_token: "the-refresh",
  token_type: "bearer",
};

describe("ApiClient", () => {
  it("uses the provided baseUrl", () => {
    const client = new ApiClient({ baseUrl: "http://localhost:9999" });
    expect(client["baseUrl"]).toBe("http://localhost:9999");
  });

  it("throws CliError on network failure", async () => {
    const fetchImpl = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const client = new ApiClient({ baseUrl: "http://localhost:1", fetchImpl });
    await expect(client.getAccount()).rejects.toBeInstanceOf(CliError);
  });

  it("throws CliError on API error with detail code", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        json({ detail: { code: "subscription_required", message: "Upgrade needed" } }, 403),
      );
    const client = new ApiClient({ baseUrl: "http://localhost:1", fetchImpl });
    await expect(client.getAccount()).rejects.toThrow("Upgrade needed");
  });
});

describe("ApiClient token refresh", () => {
  it("refreshes on 401, persists the new pair, and retries transparently", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    let refreshed: AuthSession | null = null;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string>)?.["Authorization"] ?? null;
      calls.push({ url, auth });

      if (url.endsWith("/auth/refresh")) {
        return json({ access_token: "new-access", refresh_token: "new-refresh" });
      }
      if (url.endsWith("/account/me")) {
        return auth === "Bearer old-access"
          ? json({ detail: "Token expired" }, 401)
          : json({ id: "u1", email: "dev@bluud.dev" });
      }
      return json({}, 404);
    });

    const client = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onSessionRefreshed: (s) => {
        refreshed = s;
      },
    });
    client.setSession(SESSION);

    const account = await client.getAccount();
    expect(account.email).toBe("dev@bluud.dev");

    // original (401) → refresh → retried with new token
    expect(calls.map((c) => c.url.split("/api/v1")[1])).toEqual([
      "/account/me",
      "/auth/refresh",
      "/account/me",
    ]);
    expect(calls[0].auth).toBe("Bearer old-access");
    expect(calls[2].auth).toBe("Bearer new-access");
    expect(refreshed).toEqual({
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "bearer",
    });
  });

  it("does not attempt refresh for a PAT session (empty refresh token)", async () => {
    const fetchImpl = vi.fn(async () => json({ detail: "Invalid token" }, 401));
    const client = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.setSession({ access_token: "bluud_pat_x", refresh_token: "", token_type: "bearer" });

    await expect(client.getAccount()).rejects.toMatchObject({ code: "auth_required" });
    // Exactly one call — no /auth/refresh attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original 401 when refresh itself fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        return json({ detail: "Invalid or expired refresh token" }, 401);
      }
      return json({ detail: "Token expired" }, 401);
    });
    const client = new ApiClient({
      baseUrl: "http://localhost:1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.setSession(SESSION);

    await expect(client.getAccount()).rejects.toMatchObject({ code: "auth_required" });
    // original + one refresh attempt, then give up (no infinite loop).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
