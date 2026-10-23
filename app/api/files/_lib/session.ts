import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import type { AuditEntry } from "@/lib/action";
import { log } from "@/lib/log";
import type { UploadActor } from "@/server/files";

/**
 * The session check every /api/files handler runs first (§0.1 rule 2, §4.4, §12), the same gates a
 * server action has (lib/action.ts): signed in, active profile (profiles.role), own password set,
 * two-step sign-in verified where required. Gives the handler an UploadActor whose audit() writes
 * through the insert-only log_audit_event. Per-user, so every response is no-store.
 */

export function respond(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export type RouteActor = UploadActor & { ip: string | null; userAgent: string | null };

export async function routeActor(request: NextRequest): Promise<{ actor: RouteActor } | { response: NextResponse }> {
  const session = await getSession();
  if (session.status === "anonymous") return { response: respond({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401) };
  if (session.status === "no_profile") return { response: respond({ ok: false, error: "Your account isn't set up yet. Ask a Partner.", code: "forbidden" }, 403) };
  if (session.status === "inactive") return { response: respond({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403) };
  const { user, supabase } = session;
  if (user.mustChangePassword) return { response: respond({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403) };

  let level: "aal1" | "aal2" | null = null;
  let enrolled = false;
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    level = toAal(data?.currentLevel);
    enrolled = data?.nextLevel === "aal2";
  } catch (err) {
    log("error", "assurance level lookup failed", { source: "route:/api/files", userId: user.id, role: user.role, err });
  }
  if (level !== "aal2" && (mfaRequiredFor(user.role) || enrolled)) {
    return { response: respond({ ok: false, error: "Enter the code from your authenticator app first.", code: "forbidden" }, 403) };
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
  const userAgent = request.headers.get("user-agent");
  const audit = async (entry: AuditEntry) => {
    try {
      const { error } = await supabase.rpc("log_audit_event", {
        p_event: entry.event,
        p_resource_type: entry.resourceType,
        p_resource_id: entry.resourceId ?? null,
        p_action: entry.action ?? "files",
        p_details: (entry.details ?? {}) as never,
        p_success: entry.success ?? true,
        p_error: entry.error ?? null,
        p_ip: ip,
        p_user_agent: userAgent,
      });
      if (error) throw error;
    } catch (err) {
      log("error", "audit write failed", { source: "route:/api/files", userId: user.id, role: user.role, err });
    }
  };
  return { actor: { user, supabase, audit, ip, userAgent } };
}
