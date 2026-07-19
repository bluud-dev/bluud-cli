import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  outExtension: () => ({ js: ".mjs" }),
  // Preserve dynamic imports so Node can resolve built-ins and optional deps normally.
  esbuildOptions(options) {
    options.banner = {
      js: "#!/usr/bin/env node",
    };
  },
  // Copy the bundled package assets into dist so the shim can locate them next
  // to the bundle: the skill payload delivered by `skills`, and the hook-script
  // templates the adapters materialize into each tool's config directory.
  onSuccess: async () => {
    const { cp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const asset of ["skill", "hooks"]) {
      await cp(join("src", asset), join("dist", asset), {
        recursive: true,
        force: true,
      });
    }
  },
});
