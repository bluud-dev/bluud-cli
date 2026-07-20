/**
 * Live end-to-end onboarding test.
 *
 * Unlike every other suite under `tests/`, this one makes real HTTP calls to a
 * running Bluud backend instead of mocking `fetch`. It exercises the exact
 * path `npx bluud` walks a brand-new user through:
 *
 *   1. Sign in (here: the permanent dev/test account, via email+password —
 *      see CLAUDE.md "Development Test Account").
 *   2. Mint a personal access token the same way `bluud login --token` would
 *      consume one, then authenticate the CLI's own `ApiClient` with it via
 *      `loginWithToken` (the exact function `install.ts` calls).
 *   3. Compute project identity for a throwaway directory and register it.
 *   4. Install the bundled skill into a fake Claude Code project via the exact
 *      call `install.ts` makes — whichever path is real on this machine, the
 *      separate `skills` package or Bluud's own manual-copy fallback.
 *   5. Apply the claude-code hook adapter and assert the SessionStart hook and
 *      materialized pull script exist.
 *   6. Push a memory node and pull it back, proving the full round trip
 *      against a live Postgres-backed backend, not a stub.
 *
 * This suite is opt-in (`npm run test:e2e`), not part of `npm test`: it
 * requires a live backend (`cd backend && python <the run script> `, see
 * backend/README.md) with Postgres reachable. It skips itself — loudly, via
 * console.warn, not silently — when the backend cannot be reached, so CI
 * environments without one still get a clean run rather than a false failure.
 *
 * Repeatability: this suite must be runnable an unbounded number of times.
 * There is no user-facing project-deletion endpoint (only admin hard-delete —
 * see BLUUD_ARCHITECTURE §admin), and the dev/test account is free tier, so a
 * run that registered a *fresh* project each time would silently consume the
 * 5-project free-tier allowance and then fail forever with
 * `project_limit_exceeded`. That is exactly what happened before this suite
 * was made idempotent.
 *
 * Two properties keep it repeatable, and both matter:
 *
 *   1. **A stable project directory.** Project identity is `sha256(absolute
 *      path)[:32]` for a non-git directory (concept §6.1), so a fixed path
 *      yields a fixed project id and re-registration is the idempotent
 *      "confirm existing membership" path rather than a new row. Identity
 *      depends only on the path, never on the contents, so the directory's
 *      contents are wiped each run to keep install assertions deterministic
 *      while the identity stays put.
 *   2. **The memory node is deleted again.** The push/pull round trip asserts
 *      against the node it created by id and removes it afterwards, so the
 *      tree does not grow run over run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../../src/lib/api.js";
import { loginWithToken } from "../../src/lib/auth.js";
import { requireIdentity } from "../../src/lib/identity.js";
import { installSkill, bundledSkillPath, BLUUD_SKILL_NAME } from "../../src/lib/skills.js";
import { claudeCodeAdapter } from "../../src/lib/adapters/claudecode.js";
import { hookScriptFileName } from "../../src/lib/adapters/hookScript.js";
import type { AdapterEnv } from "../../src/lib/adapters/types.js";
import type { DiffOperation } from "../../src/types.js";

const BASE_URL = process.env.BLUUD_E2E_API_URL ?? "http://127.0.0.1:8000";
const DEV_TEST_EMAIL = "dev-test@bluud.dev";
const DEV_TEST_PASSWORD = "DevTest123!";

let backendReachable = false;
let sessionAccessToken: string | null = null;
let patId: string | null = null;
let pat: string | null = null;

async function jsonFetch(
  path: string,
  init: RequestInit & { body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => null);
  return { status: response.status, body };
}

beforeAll(async () => {
  try {
    const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    backendReachable = health.ok;
  } catch {
    backendReachable = false;
  }

  if (!backendReachable) {
    console.warn(
      `[e2e] Skipping: no live backend reachable at ${BASE_URL}/health. ` +
        "Start the backend (see backend/README.md) and Postgres, then re-run `npm run test:e2e`.",
    );
    return;
  }

  const login = await jsonFetch("/api/v1/auth/login", {
    method: "POST",
    body: { email: DEV_TEST_EMAIL, password: DEV_TEST_PASSWORD },
  });
  if (login.status !== 200) {
    throw new Error(
      `[e2e] Could not log in as ${DEV_TEST_EMAIL}: HTTP ${login.status} ${JSON.stringify(login.body)}`,
    );
  }
  sessionAccessToken = (login.body as { access_token: string }).access_token;

  const minted = await jsonFetch("/api/v1/auth/cli/pat", {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionAccessToken}` },
    body: { name: `e2e-onboarding-${Date.now()}`, expires_in_days: 1 },
  });
  if (minted.status !== 201) {
    throw new Error(
      `[e2e] Could not mint a PAT: HTTP ${minted.status} ${JSON.stringify(minted.body)}`,
    );
  }
  const mintedBody = minted.body as { id: string; token: string };
  patId = mintedBody.id;
  pat = mintedBody.token;
});

afterAll(async () => {
  if (!backendReachable || !patId || !sessionAccessToken) return;
  await jsonFetch(`/api/v1/auth/cli/pat/${patId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionAccessToken}` },
  });
});

describe("live onboarding against a real backend (dev-test account)", () => {
  it("authenticates the CLI's ApiClient with the minted PAT via loginWithToken", async (ctx) => {
    if (!backendReachable) return ctx.skip();

    const api = new ApiClient({ baseUrl: BASE_URL });
    const session = await loginWithToken(api, pat as string);

    expect(session.access_token).toBe(pat);
    expect(api.isAuthenticated).toBe(true);

    const account = await api.getAccount();
    expect(account.email).toBe(DEV_TEST_EMAIL);
  });

  it("runs the full onboarding flow: identity -> register -> skill install -> hooks -> memory round trip", async (ctx) => {
    if (!backendReachable) return ctx.skip();

    const api = new ApiClient({ baseUrl: BASE_URL });
    await loginWithToken(api, pat as string);

    // A stable, non-git directory: path_hash identity that is identical on
    // every run of this suite on this machine (see the header note on
    // repeatability). Wiped and recreated so contents are deterministic.
    const projectDir = join(tmpdir(), "bluud-cli-e2e-onboarding-fixture");
    await rm(projectDir, { recursive: true, force: true });
    await mkdir(projectDir, { recursive: true });
    try {
      const identity = await requireIdentity(projectDir);
      expect(identity.identitySource).toBe("path_hash");

      const registration = await api.registerProject(identity, "bluud-cli-e2e-onboarding");
      expect(registration.project_id).toBe(identity.projectId);
      expect(registration.token.length).toBeGreaterThan(0);

      // Whether this run created the row depends on whether a previous run
      // already did, so `is_new` is not asserted directly. Re-registering is,
      // and it must take the idempotent confirm path: same project, same
      // token, no second row (and therefore no quota consumption).
      const reRegistration = await api.registerProject(identity, "bluud-cli-e2e-onboarding");
      expect(reRegistration.is_new).toBe(false);
      expect(reRegistration.project_id).toBe(identity.projectId);

      // Skill install: exactly the call `install.ts` makes (no forced
      // `copy`), so this exercises whichever path is real for this machine —
      // through the separate `skills` package if it is reachable, or Bluud's
      // own manual-copy fallback if it is not.
      const skillResult = await installSkill({
        skillName: BLUUD_SKILL_NAME,
        skillPath: bundledSkillPath(),
        agent: "claude-code",
        cwd: projectDir,
      });
      expect(skillResult.installed).toBe(true);
      // `symlink` is the local fallback's normal outcome since Phase 15 (the
      // canonical `.agents/skills` copy is linked into the agent's dir);
      // `copy` is its degraded form on a filesystem that refuses links.
      expect(["skills", "symlink", "copy"]).toContain(skillResult.mode);
      const installedSkillFile = join(
        projectDir,
        ".claude",
        "skills",
        BLUUD_SKILL_NAME,
        "SKILL.md",
      );
      expect(existsSync(installedSkillFile)).toBe(true);

      // Hook adapter: same claude-code adapter `install.ts` drives.
      const env: AdapterEnv = {
        cwd: projectDir,
        home: await mkdtemp(join(tmpdir(), "bluud-e2e-home-")),
        global: false,
        bluudBinary: "/usr/local/bin/bluud",
      };
      await mkdir(join(projectDir, ".claude"), { recursive: true });
      const adapterResult = await claudeCodeAdapter.apply(env, { dryRun: false, force: false });
      expect(adapterResult.applied).toBe(true);

      const settings = JSON.parse(
        await readFile(join(projectDir, ".claude", "settings.local.json"), "utf8"),
      );
      expect(settings.hooks.SessionStart).toHaveLength(1);
      const scriptPath = join(
        projectDir,
        ".claude",
        "bluud",
        hookScriptFileName(process.platform !== "win32"),
      );
      expect(existsSync(scriptPath)).toBe(true);
      await rm(env.home, { recursive: true, force: true });

      // Memory round trip: push a real node, then pull the tree back.
      const projectToken = registration.token;
      const bodyLine = `created at ${new Date().toISOString()}`;
      const document = [
        "---",
        "title: E2E Onboarding Node",
        "description: written by bluud-cli's live e2e onboarding test",
        "---",
        bodyLine,
      ].join("\n");
      const operations: DiffOperation[] = [{ op: "create", document }];

      const pushResult = await api.pushMemory(identity.projectId, projectToken, operations);
      expect(pushResult.read_only).toBe(false);
      expect(pushResult.nodes).toHaveLength(1);
      expect(pushResult.nodes[0]?.title).toBe("E2E Onboarding Node");

      const createdId = pushResult.nodes[0]?.id as string;
      try {
        // Locate the pushed node by id rather than asserting on tree size: the
        // project is reused across runs, so the tree is not guaranteed empty.
        const pulled = await api.pullMemory(identity.projectId, projectToken);
        const found = pulled.nodes.find((n) => n.id === createdId);
        expect(found).toBeDefined();
        expect(found?.body).toBe(bodyLine);
        expect(found?.title).toBe("E2E Onboarding Node");
      } finally {
        // Remove the node so the reused project's tree does not grow run over
        // run — the memory-side counterpart of reusing the project row.
        await api.pushMemory(identity.projectId, projectToken, [{ op: "delete", id: createdId }]);
      }

      const afterDelete = await api.pullMemory(identity.projectId, projectToken);
      expect(afterDelete.nodes.find((n) => n.id === createdId)).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects a revoked PAT (proving the afterAll cleanup path actually works)", async (ctx) => {
    if (!backendReachable) return ctx.skip();

    // Mint and immediately revoke a second, disposable PAT so this test does
    // not depend on afterAll ordering relative to its own assertion.
    const minted = await jsonFetch("/api/v1/auth/cli/pat", {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionAccessToken}` },
      body: { name: `e2e-revocation-check-${Date.now()}`, expires_in_days: 1 },
    });
    expect(minted.status).toBe(201);
    const { id, token } = minted.body as { id: string; token: string };

    const revoke = await jsonFetch(`/api/v1/auth/cli/pat/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionAccessToken}` },
    });
    expect(revoke.status).toBe(204);

    const api = new ApiClient({ baseUrl: BASE_URL });
    await expect(loginWithToken(api, token)).rejects.toThrow("The provided token is invalid.");
  });
});
