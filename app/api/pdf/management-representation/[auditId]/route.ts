import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getRepresentationLetterData } from "@/lib/data/audits";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { buildManagementRepresentationPdf } from "@/server/pdf/management-representation";

/**
 * GET /api/pdf/management-representation/<auditId>[?download=1]
 *
 * The management representation letter template for an audit engagement (SA 580; §6.9 Completion,
 * §11), as a PDF for the client to print on its letterhead, sign and date. Partners and Managers
 * only (audit engagements are theirs, §4.1, RLS 0033), at two-step sign-in (§12); Employees and
 * portal users are refused. Each download writes an export_run audit row first (§12). Errors answer
 * with the JSON contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ auditId: string }> }) {
  let userId: string | null = null;
  try {
    const { auditId } = await ctx.params;
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role !== "partner" && user.role !== "manager") return json({ ok: false, error: "Audit engagements are kept by Partners and Managers.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(auditId)) return json({ ok: false, error: "That audit engagement doesn't exist.", code: "not_found" }, 404);

    const data = await getRepresentationLetterData(supabase, auditId);
    if (!data) return json({ ok: false, error: "That audit engagement doesn't exist, or you can't see it.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "audit_engagement",
      p_resource_id: auditId,
      p_action: "audits.representation_letter_pdf",
      p_details: { audit_type: data.auditType, financial_year: data.financialYear, stage: data.stage },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const firm = await getFirmProfile(supabase);
    const { bytes, fileName } = await buildManagementRepresentationPdf({ firm, data, preparedBy: user.fullName });
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:management-representation", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
