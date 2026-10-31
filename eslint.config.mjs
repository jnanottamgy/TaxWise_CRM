import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored design-skill tooling and its working files, and the local QA stack's state: not app code.
    ".claude/**",
    ".taste-skill/**",
    ".local-stack/**",
    // Netlify's build output (functions and edge functions it generates).
    ".netlify/**",
  ]),
]);

export default eslintConfig;
