import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getSession, type CurrentUser } from "@/lib/auth/current-user";
import type { AppRole } from "@/lib/auth/roles";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * The gate the reports, audit-log and full-export downloads share (the PDF routes' gate, §12): a
 * signed-in, active person in one of `roles`, with their own password set, at two-step sign-in
 * (aal2) when their role requires it or they have turned it on. Refusals answer with the JSON
 * contract (CONVENTIONS §3.5), never cached.
 */

export type ExportGate =
  | { ok: true; user: CurrentUser; supabase: ServerSupabase }
  | { ok: false; response: NextResponse };

export function jsonResponse(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function gateExport(roles: readonly AppRole[], refusal: string): Promise<ExportGate> {
  const deny = (status: number, error: string, code: string): ExportGate => ({ ok: false, response: jsonResponse({ ok: false, error, code }, status) });
  const session = await getSession();
  if (session.status === "anonymous") return deny(401, "Your session has ended. Please sign in again.", "unauthenticated");
  if (session.status !== "ok") return deny(403, "Your access has been disabled. Ask a Partner.", "forbidden");
  const { user, supabase } = session;
  if (!roles.includes(user.role)) return deny(403, refusal, "forbidden");
  if (user.mustChangePassword) return deny(403, "Set your own password first.", "must_change_password");
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
    return deny(403, "Enter the code from your authenticator app first.", "mfa_required");
  }
  return { ok: true, user, supabase };
}

/** The caller's IP and browser, for the export_run audit row. */
export function requestOrigin(request: NextRequest): { ip: string | null; userAgent: string | null } {
  return {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent"),
  };
}

/** Writes the export_run audit row before anything is sent (§12 "every export"). Throws if it can't. */
export async function auditExport(
  supabase: ServerSupabase,
  request: NextRequest,
  entry: { resourceType: string; resourceId: string | null; action: string; details: Record<string, unknown> },
): Promise<void> {
  const { ip, userAgent } = requestOrigin(request);
  const { error } = await supabase.rpc("log_audit_event", {
    p_event: "export_run",
    p_resource_type: entry.resourceType,
    p_resource_id: entry.resourceId,
    p_action: entry.action,
    p_details: entry.details as never,
    p_success: true,
    p_error: null,
    p_ip: ip,
    p_user_agent: userAgent,
  });
  if (error) throw error;
}

/** `Content-Disposition` for a download, with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, "-").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
