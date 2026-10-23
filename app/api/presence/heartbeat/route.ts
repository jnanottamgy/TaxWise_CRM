import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected, newRef } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { recordBeat } from "@/server/presence";

/**
 * The presence heartbeat (§7.12): the staff app sends one every 5 minutes while it is open and
 * visible, and one when the tab becomes visible again (components/presence/presence-heartbeat.tsx).
 * The proxy doesn't count it as activity, so a tab left open never keeps an idle session alive
 * (lib/supabase/proxy.ts countsAsActivity).
 *
 * Who it is comes from the signed-in session (profiles.role, the staff record); the write goes
 * through server/presence.ts, which credits at most 6 minutes per beat (lib/domain/presence.ts).
 * Answers `{ ok, data | error, ref }` and is never cached.
 */
export const dynamic = "force-dynamic";

function respond(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(request: NextRequest) {
  let userId: string | null = null;
  try {
    const session = await getSession();
    if (session.status === "anonymous") return respond({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return respond({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role === "client" || !user.employeeId) return respond({ ok: false, error: "Presence is for the firm's staff.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return respond({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);

    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const level = toAal(aal?.currentLevel);
    if (level !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return respond({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
    const beat = await recordBeat({ employeeId: user.employeeId, userId: user.id, ip, userAgent: request.headers.get("user-agent") });
    return respond({ ok: true, data: beat }, 200);
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:presence/heartbeat", userId }) || newRef();
    return respond({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
