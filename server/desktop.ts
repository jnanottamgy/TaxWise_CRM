import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { getSession, type CurrentUser } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { env } from "@/lib/env";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import type { ServerSupabase } from "@/lib/supabase/server";
import { DESKTOP_VERSION_PATTERN, isDeviceKey } from "@/lib/domain/whatsapp";
import { createAdminClient } from "@/server/admin";

/**
 * The checks every TaxWise Desktop API route makes, in this order (§7.25.1, docs/DESKTOP-API.md
 * and its "Additions from the desktop security review"):
 *
 *   1. read the JSON body (POST, at most 16 KB);
 *   2. REVOCATION FIRST, before any session check: if the X-TaxWise-Device key, or the body's
 *      deviceKey, belongs to a removed PC, answer 403 `device_revoked`, so the app wipes its
 *      WhatsApp data at its next start even when nobody is signed in (§18.3 Partner 13). This one
 *      narrow read uses the service role (server/admin.ts), because there may be no session yet;
 *   3. the request must come from TaxWise Desktop: X-TaxWise-Desktop (the app's version) and a
 *      valid X-TaxWise-Device (64 lowercase hex); a body deviceKey must match the header; a POST's
 *      Origin must be the CRM's own;
 *   4. the CRM session cookie: 401 without one (never a redirect to /login); 403 for a disabled
 *      account, a client (portal) user, a temporary password, or a Partner/Manager whose session
 *      isn't verified with the authenticator app (the same two-step gate as server actions, §12);
 *   5. the body against the route's zod schema;
 *   6. the route's handler, under the person's own session (RLS applies; the desktop functions in
 *      0182 re-check the device and the person).
 *
 * Every answer is JSON `{ ok: true, data }` or `{ ok: false, error, code?, ref? }` with
 * `Cache-Control: no-store`. A handler refuses with `throw new DesktopRefusal(status, code, error)`
 * (403/404/409, a code other than device_revoked unless the PC really was removed); anything
 * unexpected is logged and answered 500 with a Ref.
 */

export const DESKTOP_DEVICE_HEADER = "x-taxwise-device";
export const DESKTOP_VERSION_HEADER = "x-taxwise-desktop";
const MAX_BODY_BYTES = 16 * 1024;

export const DEVICE_REVOKED = { ok: false as const, error: "This PC was removed from TaxWise.", code: "device_revoked" };

/** A refusal the app shows as `error` (it never wipes for these, unless code is device_revoked). */
export class DesktopRefusal extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = "DesktopRefusal";
    this.status = status;
    this.code = code;
  }
}

/** JSON with no-store; never cached, never a redirect. */
export function desktopJson(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Content-Type", "application/json; charset=utf-8");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}

export interface DesktopContext<B> {
  user: CurrentUser;
  /** The person's own session client: RLS applies. */
  supabase: ServerSupabase;
  deviceKey: string;
  appVersion: string;
  body: B;
  ip: string | null;
  userAgent: string | null;
}

type BodyRead = { ok: true; value: unknown } | { ok: false };

async function readBody(request: NextRequest): Promise<BodyRead> {
  if (request.method !== "POST") return { ok: true, value: undefined };
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/json")) return { ok: false };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false };
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false };
    return { ok: true, value: text.trim() === "" ? {} : JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** True when any of these device keys belongs to a removed PC. The service role: there may be no session. */
async function anyRevoked(keys: readonly string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  const admin = createAdminClient();
  const { data, error } = await admin.from("desktop_devices").select("id").in("device_key", [...new Set(keys)]).not("revoked_at", "is", null).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A POST must carry the CRM's own Origin (the app sends it; a cross-site page can't forge it). */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([request.nextUrl.origin, originOf(env.appUrl())].filter((o): o is string => !!o));
  return allowed.has(origin);
}

function clientIp(request: NextRequest): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

/** Runs one desktop API request through the checks above. */
export async function handleDesktop<S extends z.ZodType | null>(
  request: NextRequest,
  opts: { source: string; schema: S },
  handler: (ctx: DesktopContext<S extends z.ZodType ? z.output<S> : undefined>) => Promise<unknown>,
): Promise<NextResponse> {
  let userId: string | null = null;
  let role: string | null = null;
  try {
    const headerKey = (request.headers.get(DESKTOP_DEVICE_HEADER) ?? "").trim();
    const version = (request.headers.get(DESKTOP_VERSION_HEADER) ?? "").trim();
    const body = await readBody(request);
    const bodyKey =
      body.ok && body.value && typeof body.value === "object" && !Array.isArray(body.value) && typeof (body.value as Record<string, unknown>).deviceKey === "string"
        ? ((body.value as Record<string, unknown>).deviceKey as string)
        : null;

    // 2. Revocation before the session.
    const keys = [headerKey, bodyKey ?? ""].filter((k) => isDeviceKey(k));
    if (await anyRevoked(keys)) {
      log("info", "removed PC refused", { source: opts.source });
      return desktopJson(DEVICE_REVOKED, 403);
    }

    // 3. Only TaxWise Desktop.
    if (!DESKTOP_VERSION_PATTERN.test(version)) {
      return desktopJson({ ok: false, error: "This address is for TaxWise Desktop.", code: "forbidden" }, 403);
    }
    if (!isDeviceKey(headerKey)) {
      return desktopJson({ ok: false, error: "This PC's key is missing or invalid. Restart TaxWise Desktop.", code: "forbidden" }, 403);
    }
    if (bodyKey !== null && bodyKey !== headerKey) {
      return desktopJson({ ok: false, error: "This PC's key doesn't match. Restart TaxWise Desktop.", code: "forbidden" }, 403);
    }
    if (request.method === "POST" && !sameOrigin(request)) {
      return desktopJson({ ok: false, error: "TaxWise refused a request from another site.", code: "forbidden" }, 403);
    }
    if (!body.ok) {
      return desktopJson({ ok: false, error: "TaxWise Desktop sent a request this CRM doesn't understand. Update TaxWise Desktop.", code: "validation" }, 400);
    }

    // 4. The session.
    const session = await getSession();
    if (session.status === "anonymous") {
      return desktopJson({ ok: false, error: "Sign in to TaxWise first.", code: "unauthenticated" }, 401);
    }
    if (session.status === "no_profile") {
      return desktopJson({ ok: false, error: "Your account isn't set up yet. Ask a Partner.", code: "forbidden" }, 403);
    }
    if (session.status === "inactive") {
      return desktopJson({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    }
    const { user, supabase } = session;
    userId = user.id;
    role = user.role;
    if (user.role === "client") {
      return desktopJson({ ok: false, error: "TaxWise Desktop is for the firm's staff.", code: "forbidden" }, 403);
    }
    if (user.mustChangePassword) {
      return desktopJson({ ok: false, error: "Set your own password in TaxWise first.", code: "must_change_password" }, 403);
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return desktopJson({ ok: false, error: "Enter the code from your authenticator app in TaxWise first.", code: "mfa_required" }, 403);
    }

    // 5. The body.
    let parsed: unknown = undefined;
    if (opts.schema) {
      const r = opts.schema.safeParse(body.value);
      if (!r.success) {
        return desktopJson({ ok: false, error: r.error.issues[0]?.message ?? "TaxWise Desktop sent something this CRM doesn't understand.", code: "validation" }, 400);
      }
      parsed = r.data;
    }

    // 6. The route.
    const data = await handler({
      user,
      supabase,
      deviceKey: headerKey,
      appVersion: version,
      body: parsed as S extends z.ZodType ? z.output<S> : undefined,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    return desktopJson({ ok: true, data: data ?? {} }, 200);
  } catch (err) {
    if (err instanceof DesktopRefusal) {
      if (err.code === "device_revoked") return desktopJson(DEVICE_REVOKED, 403);
      return desktopJson({ ok: false, error: err.message, code: err.code }, err.status);
    }
    const ref = logUnexpected(err, { source: opts.source, userId, role });
    return desktopJson({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}

/** The status a 0182 desktop function answered with, as a refusal (or nothing for 'ok'). */
export function refuseUnlessOk(result: { status?: unknown; error?: unknown } | null | undefined): void {
  const status = typeof result?.status === "string" ? result.status : "unexpected";
  const message = typeof result?.error === "string" && result.error ? result.error : null;
  switch (status) {
    case "ok":
      return;
    case "revoked":
      throw new DesktopRefusal(403, "device_revoked", DEVICE_REVOKED.error);
    case "not_found":
      throw new DesktopRefusal(404, "not_found", message ?? "This PC hasn't checked in with TaxWise yet. Restart TaxWise Desktop.");
    case "forbidden":
      throw new DesktopRefusal(403, "forbidden", message ?? "You don't have permission to do that.");
    default:
      throw new Error(`desktop function answered ${status}`);
  }
}

/** An audit row under the person's session (log_audit_event). Never throws. */
export async function desktopAudit(
  ctx: Pick<DesktopContext<unknown>, "supabase" | "ip" | "userAgent" | "user">,
  entry: { event: "record_viewed" | "access_denied" | "data_update" | "config_change"; resourceType: string; resourceId?: string | null; action: string; details?: Record<string, unknown>; success?: boolean; error?: string | null },
): Promise<void> {
  try {
    const { error } = await ctx.supabase.rpc("log_audit_event", {
      p_event: entry.event,
      p_resource_type: entry.resourceType,
      p_resource_id: entry.resourceId ?? null,
      p_action: entry.action,
      p_details: (entry.details ?? {}) as never,
      p_success: entry.success ?? true,
      p_error: entry.error ?? null,
      p_ip: ctx.ip,
      p_user_agent: ctx.userAgent,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "desktop audit write failed", { source: `desktop:${entry.action}`, userId: ctx.user.id, role: ctx.user.role, err });
  }
}
