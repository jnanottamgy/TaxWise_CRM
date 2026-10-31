import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["node_modules", "tests/db/**", "tests/e2e/**"],
    reporters: "default",
  },
});
