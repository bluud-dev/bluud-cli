import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.eslint.json",
      },
    },
  },
  {
    files: ["bin/cli.mjs", "scripts/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off",
    },
  },
  {
    // `src/hooks` is excluded for the same reason it is excluded from
    // tsconfig.json: it holds materialized artifacts for *other* tools, and
    // the Pi extension template is not valid TypeScript until the adapter
    // substitutes its `@BLUUD_BINARY@` placeholder.
    ignores: ["dist", "node_modules", "coverage", "src/hooks"],
  }
);
