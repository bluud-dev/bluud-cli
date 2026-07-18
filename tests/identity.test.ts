import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { computeIdentity, normalizeGitRemote, normalizePath } from "../src/lib/identity.js";

describe("identity", () => {
  describe("normalizeGitRemote", () => {
    it("strips credentials from https urls", () => {
      expect(normalizeGitRemote("https://user:pass@github.com/owner/repo.git")).toBe(
        "github.com/owner/repo",
      );
    });

    it("normalizes ssh shorthand", () => {
      expect(normalizeGitRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
    });

    it("handles ssh:// protocol", () => {
      expect(normalizeGitRemote("ssh://git@github.com/owner/repo.git")).toBe(
        "github.com/owner/repo",
      );
    });

    it("strips trailing .git and slashes", () => {
      expect(normalizeGitRemote("https://github.com/owner/repo/")).toBe("github.com/owner/repo");
    });

    it("lowercases the result", () => {
      expect(normalizeGitRemote("HTTPS://GitHub.Com/Owner/Repo.GIT")).toBe("github.com/owner/repo");
    });
  });

  describe("normalizePath", () => {
    it("converts backslashes to forward slashes", () => {
      expect(normalizePath("C:\\Users\\dev\\project")).toBe("C:/Users/dev/project");
    });

    it("strips trailing slash", () => {
      expect(normalizePath("/home/dev/project/")).toBe("/home/dev/project");
    });
  });

  describe("computeIdentity", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "bluud-identity-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("uses git remote origin when present", async () => {
      const repoDir = join(tempDir, "repo");
      await mkdir(repoDir);
      const git = simpleGit(repoDir);
      await git.init();
      await git.addRemote("origin", "https://github.com/owner/repo.git");

      const identity = await computeIdentity(repoDir);

      expect(identity.identitySource).toBe("git_remote");
      expect(identity.gitRemote).toBe("github.com/owner/repo");
      expect(identity.projectId).toHaveLength(32);
      expect(identity.path).toBe(repoDir);
    });

    it("falls back to absolute path hash when no git remote exists", async () => {
      const plainDir = join(tempDir, "plain");
      await mkdir(plainDir);

      const identity = await computeIdentity(plainDir);

      expect(identity.identitySource).toBe("path_hash");
      expect(identity.gitRemote).toBeNull();
      expect(identity.projectId).toHaveLength(32);
      expect(identity.path).toBe(plainDir);
    });

    it("falls back to path hash when the directory is not a git repo", async () => {
      const notGitDir = join(tempDir, "not-git");
      await mkdir(notGitDir);
      await writeFile(join(notGitDir, "file.txt"), "hello");

      const identity = await computeIdentity(notGitDir);

      expect(identity.identitySource).toBe("path_hash");
    });

    it("is deterministic for the same git remote", async () => {
      const repoA = join(tempDir, "repo-a");
      const repoB = join(tempDir, "repo-b");
      await mkdir(repoA);
      await mkdir(repoB);
      const gitA = simpleGit(repoA);
      const gitB = simpleGit(repoB);
      await gitA.init();
      await gitB.init();
      await gitA.addRemote("origin", "https://github.com/owner/repo.git");
      await gitB.addRemote("origin", "https://github.com/owner/repo.git");

      const identityA = await computeIdentity(repoA);
      const identityB = await computeIdentity(repoB);

      expect(identityA.projectId).toBe(identityB.projectId);
    });
  });
});
