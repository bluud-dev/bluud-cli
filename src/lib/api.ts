/**
 * Typed REST client for the Bluud backend.
 *
 * Uses Node's built-in `fetch`.  All endpoints are under `/api/v1`.
 */

import { CliError, statusToErrorCode, type ErrorCode } from "./error.js";
import type {
  AuthSession,
  DiffOperation,
  MemoryPushResult,
  MemoryTree,
  ProjectIdentity,
  ProjectStatus,
} from "../types.js";

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Invoked whenever the session's access/refresh pair is silently rotated by
   * an automatic refresh, so the caller can persist the new pair to disk. The
   * request that triggered the refresh is retried transparently afterward.
   */
  onSessionRefreshed?: (session: AuthSession) => void | Promise<void>;
}

const DEFAULT_BASE_URL = "https://api.bluud.dev";

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onSessionRefreshed?: (session: AuthSession) => void | Promise<void>;
  private session: AuthSession | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.BLUUD_API_URL ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onSessionRefreshed = options.onSessionRefreshed;
  }

  setSession(session: AuthSession | null): void {
    this.session = session;
  }

  get isAuthenticated(): boolean {
    return this.session !== null;
  }

  /**
   * A session can be refreshed only when it carries a refresh token. PAT
   * sessions store an empty refresh token, so a 401 on a PAT surfaces directly
   * (the fix is a new PAT, not a refresh).
   */
  private canRefresh(): boolean {
    return this.session !== null && this.session.refresh_token.length > 0;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async exchangeCliToken(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<AuthSession> {
    const body = await this.request<AuthSession>("POST", "/auth/cli/token", {
      body: { code, code_verifier: codeVerifier, redirect_uri: redirectUri },
    });
    return { ...body, token_type: "bearer" };
  }

  async getAccount(): Promise<{ id: string; email: string }> {
    return this.request<{ id: string; email: string }>("GET", "/account/me");
  }

  async logout(refreshToken: string): Promise<void> {
    await this.request("POST", "/auth/logout", {
      body: { refresh_token: refreshToken },
    });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async registerProject(
    identity: ProjectIdentity,
    displayName: string | null,
  ): Promise<{ project_id: string; display_name: string | null; token: string; is_new: boolean }> {
    return this.request<{
      project_id: string;
      display_name: string | null;
      token: string;
      is_new: boolean;
    }>("POST", "/projects/register", {
      body: {
        git_remote: identity.gitRemote,
        path: identity.identitySource === "path_hash" ? identity.path : undefined,
        display_name: displayName,
      },
    });
  }

  async getProjectStatus(projectId: string): Promise<ProjectStatus> {
    return this.request<ProjectStatus>("GET", `/projects/${projectId}/status`);
  }

  async syncProjectToken(projectId: string): Promise<string> {
    const result = await this.request<{ token: string }>(
      "GET",
      `/projects/${projectId}/token/sync`,
    );
    return result.token;
  }

  async rotateProjectToken(projectId: string): Promise<string> {
    const result = await this.request<{ token: string }>(
      "POST",
      `/projects/${projectId}/token/rotate`,
    );
    return result.token;
  }

  async relinkProject(projectId: string): Promise<string> {
    const result = await this.request<{ token: string }>("POST", "/remap/relink", {
      body: { project_id: projectId },
    });
    return result.token;
  }

  async listOwnedProjects(): Promise<
    Array<{
      project_id: string;
      display_name: string | null;
      identity_source: "git_remote" | "path_hash";
      read_only: boolean;
      created_at: string;
      last_activity_at: string;
    }>
  > {
    const result = await this.request<{
      projects: Array<{
        project_id: string;
        display_name: string | null;
        identity_source: "git_remote" | "path_hash";
        read_only: boolean;
        created_at: string;
        last_activity_at: string;
      }>;
    }>("GET", "/remap/projects");
    return result.projects;
  }

  async reassignProject(targetProjectId: string): Promise<string> {
    const result = await this.request<{ token: string }>("POST", "/remap/reassign", {
      body: { target_project_id: targetProjectId },
    });
    return result.token;
  }

  // -------------------------------------------------------------------------
  // Memory (project-token auth)
  // -------------------------------------------------------------------------

  async pullMemory(projectId: string, projectToken: string): Promise<MemoryTree> {
    return this.request<MemoryTree>("GET", `/memory/${projectId}`, {
      projectToken,
    });
  }

  async pushMemory(
    projectId: string,
    projectToken: string,
    operations: DiffOperation[],
  ): Promise<MemoryPushResult> {
    return this.request<MemoryPushResult>("PATCH", `/memory/${projectId}`, {
      projectToken,
      body: { operations },
    });
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; projectToken?: string } = {},
  ): Promise<T> {
    return this.requestOnce<T>(method, path, options, true);
  }

  /**
   * Perform a single request, with one transparent refresh-and-retry.
   *
   * When a session-authenticated call returns 401 and the session is
   * refreshable, we rotate the pair via `/auth/refresh` and replay the original
   * request exactly once (`allowRefresh=false` on the replay) so a lapsed
   * access token never surfaces to the user. Project-token calls and PAT
   * sessions skip refresh entirely.
   */
  private async requestOnce<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; projectToken?: string },
    allowRefresh: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const usesSessionAuth = !options.projectToken && this.session !== null;
    let authToken: string | null = null;
    if (options.projectToken) {
      authToken = options.projectToken;
    } else if (this.session) {
      authToken = this.session.access_token;
    }

    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const url = `${this.baseUrl}/api/v1${path}`;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new CliError(`Network error contacting ${this.baseUrl}`, {
        code: "network_error",
        cause: err,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      if (response.status === 401 && allowRefresh && usesSessionAuth && this.canRefresh()) {
        const refreshed = await this.performRefresh();
        if (refreshed) {
          return this.requestOnce<T>(method, path, options, false);
        }
      }
      throw apiError(response.status, body);
    }

    return body as T;
  }

  /**
   * Rotate the session pair against `/auth/refresh`. Returns true and updates
   * the in-memory session (notifying `onSessionRefreshed`) on success; returns
   * false on any failure so the caller surfaces the original 401 as
   * `auth_required` ("run `bluud login`").
   */
  private async performRefresh(): Promise<boolean> {
    if (this.session === null) {
      return false;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh_token: this.session.refresh_token }),
      });
    } catch {
      return false;
    }
    if (!response.ok) {
      return false;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return false;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).access_token !== "string" ||
      typeof (body as Record<string, unknown>).refresh_token !== "string"
    ) {
      return false;
    }
    const pair = body as { access_token: string; refresh_token: string };
    const next: AuthSession = {
      access_token: pair.access_token,
      refresh_token: pair.refresh_token,
      token_type: "bearer",
    };
    this.session = next;
    if (this.onSessionRefreshed) {
      await this.onSessionRefreshed(next);
    }
    return true;
  }
}

function apiError(status: number, body: unknown): CliError {
  const detail =
    typeof body === "object" &&
    body !== null &&
    "detail" in body &&
    (typeof body.detail === "string" || typeof body.detail === "object")
      ? body.detail
      : body;

  const message =
    typeof detail === "string"
      ? detail
      : typeof detail === "object" &&
          detail !== null &&
          "message" in detail &&
          typeof detail.message === "string"
        ? detail.message
        : `Request failed with status ${status}`;

  const code =
    typeof detail === "object" &&
    detail !== null &&
    "code" in detail &&
    typeof detail.code === "string" &&
    isKnownErrorCode(detail.code)
      ? (detail.code as ErrorCode)
      : statusToErrorCode(status);

  return new CliError(message, { code });
}

const KNOWN_ERROR_CODES = new Set<ErrorCode>([
  "auth_required",
  "auth_failed",
  "network_error",
  "api_error",
  "config_error",
  "identity_error",
  "project_not_found",
  "project_limit_exceeded",
  "subscription_required",
  "project_locked",
  "cancelled",
  "unknown",
]);

function isKnownErrorCode(code: string): code is ErrorCode {
  return KNOWN_ERROR_CODES.has(code as ErrorCode);
}
