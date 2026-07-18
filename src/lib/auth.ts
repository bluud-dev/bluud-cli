/**
 * Authentication logic for the Bluud CLI.
 *
 * Supports two credential models:
 *   1. Browser loopback login via OAuth 2.0 PKCE (primary).
 *   2. Personal access token pasted from the dashboard (fallback / CI).
 */

import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";
import { openBrowser } from "./browser.js";
import { ApiClient } from "./api.js";
import { CliError } from "./error.js";
import type { AuthSession } from "../types.js";

const PKCE_VERIFIER_BYTES = 48;
const CLI_AUTHORIZE_URL = "https://bluud.dev/cli/authorize";

export interface LoopbackResult {
  success: boolean;
  manualUrl?: string;
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url").replace(/=+$/, "");
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

export async function loginWithBrowser(api: ApiClient): Promise<AuthSession> {
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(16).toString("hex");

  // Bind a single ephemeral loopback server up front. The same server both
  // supplies the redirect_uri (its actual port) and later handles the
  // browser's callback — binding twice on the same port would EADDRINUSE.
  const loopback = await startLoopback(state);
  try {
    const authorizeUrl = new URL(CLI_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("redirect_uri", loopback.redirectUri);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);

    const opened = await openBrowser(authorizeUrl.toString());
    if (!opened) {
      throw new CliError(
        `Could not open a browser. Please authenticate manually at:\n  ${authorizeUrl.toString()}`,
        { code: "auth_failed" },
      );
    }

    const code = await loopback.waitForCode();
    return await api.exchangeCliToken(code, verifier, loopback.redirectUri);
  } finally {
    loopback.close();
  }
}

export async function loginWithToken(api: ApiClient, pat: string): Promise<AuthSession> {
  api.setSession({ access_token: pat, refresh_token: "", token_type: "bearer" });
  // Verify the PAT works by fetching the current account.
  const account = await api.getAccount();
  if (!account || !account.email) {
    throw new CliError("The provided token is invalid.", { code: "auth_failed" });
  }
  return { access_token: pat, refresh_token: "", token_type: "bearer" };
}

interface Loopback {
  /** The loopback callback URL the CLI hands to the authorize endpoint. */
  redirectUri: string;
  /** Resolves with the authorization code once the browser calls back. */
  waitForCode(): Promise<string>;
  /** Idempotently shuts the server down. Safe to call in a `finally`. */
  close(): void;
}

/**
 * Start ONE ephemeral loopback HTTP server bound to a random 127.0.0.1 port
 * and return a handle over it.
 *
 * The single server both determines the redirect URI (from its actual bound
 * port) and handles the browser's callback. It must never be re-bound: opening
 * a second server on the same port fails with EADDRINUSE.
 */
async function startLoopback(expectedState: string): Promise<Loopback> {
  let settle: { resolve: (code: string) => void; reject: (err: unknown) => void } | null = null;
  let pending: { code?: string; error?: unknown } = {};

  const server = createServer((req, res) => {
    let outcome: { code: string } | { error: CliError };
    try {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error) {
        outcome = { error: new CliError(`Authorization failed: ${error}`, { code: "auth_failed" }) };
      } else if (state !== expectedState) {
        // Reject on state mismatch (CSRF guard) — but only for a request that
        // is actually a callback attempt, so stray probes don't kill the flow.
        outcome = {
          error: new CliError("Invalid state parameter in callback", { code: "auth_failed" }),
        };
      } else if (!code) {
        respondError(res, "Missing authorization code");
        return;
      } else {
        outcome = { code };
      }
    } catch {
      respondError(res, "Malformed callback request");
      return;
    }

    if ("error" in outcome) {
      respondError(res, outcome.error.message);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h1>Authorized</h1><p>You can close this tab and return to the terminal.</p></body></html>`,
      );
    }

    if (settle) {
      "error" in outcome ? settle.reject(outcome.error) : settle.resolve(outcome.code);
    } else {
      pending = "error" in outcome ? { error: outcome.error } : { code: outcome.code };
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new CliError("Could not determine loopback port", { code: "auth_failed" }));
        return;
      }
      resolve(address.port);
    });
  });

  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      server.close();
    }
  };

  const waitForCode = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      // A callback that arrived before waitForCode() was awaited.
      if (pending.code !== undefined) {
        resolve(pending.code);
        return;
      }
      if (pending.error !== undefined) {
        reject(pending.error);
        return;
      }
      settle = { resolve, reject };
      const timeout = setTimeout(
        () =>
          reject(
            new CliError("Authorization timed out. Please try `bluud login` again.", {
              code: "auth_failed",
            }),
          ),
        5 * 60 * 1000,
      );
      const clear = (): void => clearTimeout(timeout);
      const wrapped = settle;
      settle = {
        resolve: (code) => {
          clear();
          wrapped.resolve(code);
        },
        reject: (err) => {
          clear();
          wrapped.reject(err);
        },
      };
    });

  return { redirectUri: `http://127.0.0.1:${port}/callback`, waitForCode, close };
}

function respondError(res: import("node:http").ServerResponse, message: string): void {
  res.writeHead(400, { "Content-Type": "text/plain" });
  res.end(message);
}
