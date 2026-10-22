import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every screen is per-user and RLS-scoped; nothing is cached across users (§0.1 rule 15).
  cacheComponents: false,
  poweredByHeader: false,
  serverExternalPackages: ["@react-pdf/renderer", "exceljs", "pg"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
