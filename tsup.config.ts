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
    const { cp, readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const asset of ["skill", "hooks"]) {
      await cp(join("src", asset), join("dist", asset), {
        recursive: true,
        force: true,
      });
    }

    // Pin the bundled skill to this exact CLI version (BLUUD_CLI_ARCHITECTURE.md
    // decision #4: skill files are "version-pinned to the CLI"). Stamped only
    // into dist/ — the src/skill/SKILL.md checked into git carries no version,
    // so package.json stays the single source of truth and can never drift out
    // of sync with a hand-edited frontmatter value.
    const { stampSkillVersion } = await import("./src/lib/skillVersion.js");
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const skillPath = join("dist", "skill", "SKILL.md");
    const original = await readFile(skillPath, "utf8");
    await writeFile(skillPath, stampSkillVersion(original, pkg.version), "utf8");
  },
});
