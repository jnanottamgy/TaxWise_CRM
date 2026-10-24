import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getRunDetail } from "@/lib/data/gst-recon";
import { buildGstReconWorkbook, gstReconFileName } from "@/server/exports/gst-recon";

/**
 * GET /api/exports/gst-recon/<runId>
 *
 * The GST reconciliation workbook (§6.12 "Excel export", §7.8.1): summary, every line, the supplier
 * roll-up, the IMS action list, what carried forward and the files' issues. Any staff member who
 * can see the client (RLS: Employees their own clients, §4.1), at two-step sign-in for Partners and
 * Managers (§12); an export_run audit row is written first. No fee data is in it. Errors answer
 * with the JSON contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  let userId: string | null = null;
  try {
    const { runId } = await ctx.params;
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role === "client") return json({ ok: false, error: "GST reconciliations are prepared by the firm.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(runId)) return json({ ok: false, error: "That reconciliation doesn't exist.", code: "not_found" }, 404);

    const detail = await getRunDetail(supabase, runId);
    if (!detail) return json({ ok: false, error: "That reconciliation doesn't exist, or the client isn't one of yours.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "gst_recon_run",
      p_resource_id: runId,
      p_action: "gst_recon.export_xlsx",
      p_details: { client_id: detail.run.client_id, period: detail.run.period },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const { bytes } = await buildGstReconWorkbook(supabase, detail);
    const file = gstReconFileName(detail.client.code, detail.run.period);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:gst-recon", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
