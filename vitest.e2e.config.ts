import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // Real network calls to a live backend plus PAT mint/revoke round trips
    // take longer than the hermetic unit suite's default timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
