import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    // Nested worktrees live inside the repo; their .next output is megabytes of
    // generated chunks and linting it OOMs Node (8GB heap exhausted, 2026-09-02).
    "**/.next/**",
    ".claude/worktrees/**",
    ".worktrees/**",
    // Untracked local scratch folder on the dev machine (Codex reports, CSV exports,
    // a minified pdf-lib copy, old node test scripts); never app code.
    "gtr-probuild/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/**",
    "*.js",
    "prisma/**",
    "qa-report/**",
  ]),
  {
    // Scope to the file types eslint-config-next registers the react-hooks plugin for.
    // Without this the rules below also apply to *.cjs (tests/fixed-date-preload.cjs),
    // where the plugin is not loaded, and ESLint aborts with "could not find plugin".
    files: ["**/*.{js,jsx,mjs,ts,tsx}"],
    rules: {
      // Warn instead of error until existing code is cleaned up
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-unused-vars": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);

export default eslintConfig;