import { describe, it, expect } from "vitest";
import { normalizeGitRemote, normalizePath } from "../src/lib/identity.js";

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
});
