import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { addMonths, todayIST } from "@/lib/domain/fy";
import { gstr1PeriodProblem, parseGstr1Period } from "@/lib/domain/gstr1";
import { gstr1JsonFile, gstr1Workbook, loadGstr1 } from "@/server/exports/gstr1";

/**
 * GET /api/exports/gstr1?period=2026-09|Q2 2026-27&format=xlsx|json
 *
 * TaxWise's own GSTR-1 for a month or a quarter (§7.9.8): B2B, B2CL, B2CS, CDNR / CDNUR, nil-rated
 * and exempt, the HSN/SAC summary (B2B and B2C) and the documents issued, as the GST offline tool's
 * Excel workbook (default) or the GSTR-1 JSON. Without a period, last month. Partners and Managers
 * only (§4.1), at two-step sign-in (§12); every export writes an export_run audit row first, and
 * isn't made if that fails. Errors answer with the JSON contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest) {
  let userId: string | null = null;
  try {
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role !== "partner" && user.role !== "manager") return json({ ok: false, error: "Only Partners and Managers export TaxWise's GSTR-1.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }

    const p = request.nextUrl.searchParams;
    const today = todayIST();
    const period = parseGstr1Period(p.get("period") ?? addMonths(today, -1).slice(0, 7));
    if (!period) return json({ ok: false, error: "Choose a month (2026-09) or a quarter (Q2 2026-27).", code: "validation" }, 400);
    const problem = gstr1PeriodProblem(period, today);
    if (problem) return json({ ok: false, error: problem, code: "validation" }, 400);
    const format = p.get("format") === "json" ? "json" : "xlsx";

    const data = await loadGstr1(supabase, period);
    if (format === "json" && !data.firmGstin) return json({ ok: false, error: "Add the firm's GSTIN in Settings → Firm details first: the JSON names it.", code: "validation" }, 400);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "gstr1",
      p_resource_id: period.fp,
      p_action: `collections.gstr1_${format}`,
      p_details: { period: period.label, format, invoices: data.ret.totals.invoices, notes: data.ret.totals.notes },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const name = `GSTR1-${data.firmGstin ?? "TaxWise"}-${period.fp}`;
    const bytes = format === "json" ? gstr1JsonFile(data, period) : await gstr1Workbook(data, period);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": format === "json" ? "application/json; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.${format}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:gstr1", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
