#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("../package.json"));
const bundled = resolve(packageDir, "dist", "cli.mjs");

if (existsSync(bundled)) {
  await import(pathToFileURL(bundled).href);
} else {
  const pkg = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
  process.stderr.write(`Bluud CLI v${pkg.version} has not been built yet. Run: npm run build\n`);
  process.exit(1);
}
