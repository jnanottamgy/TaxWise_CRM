import { NextResponse, type NextRequest } from "next/server";
import { createElement } from "react";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { fyEnd, fyStart, todayIST } from "@/lib/domain/fy";
import { getSelectedFy } from "@/lib/fy-context";
import { ReportRangeSchema } from "@/lib/schemas/compliance";
import { getComplianceReportData } from "@/lib/data/compliance";
import { getFirmProfile } from "@/server/firm";
import { loadFirmLogo, pdfFileName, pdfResponseHeaders, renderPdf } from "@/server/pdf";
import { ComplianceReportPdf } from "@/server/compliance/report-pdf";

/**
 * GET /api/pdf/compliance-report/<clientId>?from=YYYY-MM-DD&to=YYYY-MM-DD[&download=1]
 *
 * The client compliance report (§7.7, §11) as a branded PDF: every statutory deadline due in the
 * range, its status, filed-on date, acknowledgement number and whether it was on time. Any staff
 * member who can see the client (RLS: Employees their own clients, §4.1), at two-step sign-in for
 * Partners and Managers (§12). The range defaults to the FY chosen in the top bar. Each download
 * writes an export_run audit row first (§12); no fee data is on it. Errors answer with the JSON
 * contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ clientId: string }> }) {
  let userId: string | null = null;
  try {
    const { clientId } = await ctx.params;
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role === "client") return json({ ok: false, error: "The compliance report is prepared by the firm. Your deadlines are on the portal's Deadlines page.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    // The same gate as server actions and the file routes: required roles, and anyone who turned
    // two-step sign-in on, must have verified this session (§12).
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(clientId)) return json({ ok: false, error: "That client doesn't exist.", code: "not_found" }, 404);

    const p = request.nextUrl.searchParams;
    const fy = await getSelectedFy();
    const range = ReportRangeSchema.safeParse({ from: p.get("from") ?? fyStart(fy), to: p.get("to") ?? fyEnd(fy) });
    if (!range.success) return json({ ok: false, error: range.error.issues[0]?.message ?? "Choose a valid period.", code: "validation" }, 400);

    const data = await getComplianceReportData(supabase, clientId, range.data);
    if (!data) return json({ ok: false, error: "That client isn't in your client list.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "compliance_report",
      p_resource_id: clientId,
      p_action: "compliance.report_pdf",
      p_details: { from: range.data.from, to: range.data.to, deadlines: data.rows.length },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const today = todayIST();
    const firm = await getFirmProfile(supabase);
    const logo = await loadFirmLogo(firm).catch(() => null);
    const bytes = await renderPdf(createElement(ComplianceReportPdf, { firm, logo, data, range: range.data, today, preparedBy: user.fullName }) as never);
    const name = pdfFileName(`${data.client.client_code} ${range.data.from} to ${range.data.to}`, "Compliance report");
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(name, { download: p.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:compliance-report", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
