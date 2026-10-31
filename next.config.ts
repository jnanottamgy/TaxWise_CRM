import type { NextConfig } from "next";

/**
 * Web hardening headers (§12). The CSP allows only this app, the Supabase project (API, Storage for
 * the logo, Realtime), self-hosted fonts (@fontsource, served from /_next/static), and blob:/data:
 * images (logo preview before upload, the UPI QR code). Nothing may frame the app.
 *
 * Scripts and styles keep 'unsafe-inline' because pages are rendered without per-request nonces
 * (Next.js inlines its RSC payload scripts; Radix sets inline styles). The rest of the policy still
 * blocks third-party script, frames, plugins, form posts elsewhere and base-tag hijacks.
 */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabase = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseWs = supabase ? supabase.replace(/^http/, "ws") : null;

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:", ...(supabase ? [supabase] : [])],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(supabase ? [supabase] : []), ...(supabaseWs ? [supabaseWs] : []), ...(isDev ? ["ws:"] : [])],
    "media-src": ["'self'", "blob:"],
    "frame-src": ["'self'", "blob:", ...(supabase ? [supabase] : [])],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  // Only on the deployed environments: on `next start` over http://localhost it would rewrite the
  // app's own asset URLs to https and break the page (local e2e runs).
  const deployed = process.env.APP_ENV === "production" || process.env.APP_ENV === "staging";
  if (deployed) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

const PERMISSIONS_POLICY = [
  "camera=(self)", // portal document upload from the phone camera (§7.22)
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "display-capture=()",
  "browsing-topics=()",
].join(", ");

const nextConfig: NextConfig = {
  // Every screen is per-user and RLS-scoped; nothing is cached across users (§0.1 rule 15).
  cacheComponents: false,
  poweredByHeader: false,
  // Netlify sets COMMIT_REF during the build only: carry it into the server code so /api/health can
  // name the deployed commit.
  env: { COMMIT_REF: process.env.COMMIT_REF ?? "" },
  experimental: {
    // forbidden() → app/(staff)/forbidden.tsx and app/(portal)/portal/forbidden.tsx: a real 403 for a
    // page the role may not open (lib/auth/guards.ts denyAccess). Without it, denyAccess falls back to 404.
    authInterrupts: true,
  },
  serverExternalPackages: ["@react-pdf/renderer", "exceljs", "pg"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
          // same-origin-allow-popups, not same-origin: the WhatsApp Web window the app opens (Send on
          // WhatsApp, Open chat) has to stay reachable by its name, so the next send reuses it instead of
          // opening another (WhatsApp Web allows one active tab). Sites that open the app still can't reach
          // it, and the app cuts the WhatsApp window's link back to it (whatsapp-button.tsx).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          // §12: nothing is indexed except the sign-in page (overridden below).
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // Later entries override earlier ones for the same key (next.config headers docs).
        source: "/login",
        headers: [{ key: "X-Robots-Tag", value: "all" }],
      },
    ];
  },
};

export default nextConfig;
