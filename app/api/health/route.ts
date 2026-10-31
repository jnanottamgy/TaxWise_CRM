import { NextResponse } from "next/server";
import pkg from "@/package.json";

/**
 * Public liveness check for uptime monitors (§7.24). Answers only `{ ok: true, version }`: no
 * database call, no environment details, nothing about users. The proxy lets it through without a
 * session (lib/supabase/proxy.ts, MACHINE_PREFIXES). For the full picture, a Partner opens
 * Settings → Diagnostics.
 *
 * `version` is the package version, plus the short commit: APP_BUILD_ID when set, else the commit
 * Netlify built (COMMIT_REF, carried into the build by next.config.ts).
 */
export const dynamic = "force-dynamic";

function buildVersion(): string {
  const build = (process.env.APP_BUILD_ID || process.env.COMMIT_REF || "").trim();
  const short = /^[0-9a-zA-Z._-]{1,64}$/.test(build) ? build.slice(0, 12) : "";
  return short ? `${pkg.version}+${short}` : pkg.version;
}

function respond(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function GET() {
  try {
    return respond({ ok: true, version: buildVersion() }, 200);
  } catch {
    // Nothing above can realistically throw; if it does, still answer in the contract's shape.
    return respond({ ok: false, version: null }, 500);
  }
}

export function HEAD() {
  return new NextResponse(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
