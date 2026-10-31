import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { log } from "@/lib/log";

/** A no-store JSON answer for the /api/cron routes (CONVENTIONS §3.5). */
export function respond(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * The /api/cron routes trust only `Authorization: Bearer <CRON_SECRET>` (compared in constant time).
 * Returns null when the call may go ahead; otherwise the response refusing it: 503 when CRON_SECRET
 * isn't set, 401 for a missing or wrong secret.
 */
export function refuseUnlessCron(request: Request, source: string): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    log("warn", "cron call received but CRON_SECRET isn't set", { source });
    return respond({ ok: false, error: "CRON_SECRET isn't configured.", code: "not_configured" }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  const expected = Buffer.from(secret);
  if (given.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    log("warn", "cron call refused: bad or missing secret", { source });
    return respond({ ok: false, error: "Not authorised.", code: "forbidden" }, 401);
  }
  return null;
}
