import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Database tests: real Postgres (local) with the Supabase shim, one test database per file.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
