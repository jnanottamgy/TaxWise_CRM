import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { formatDate } from "@/lib/format";
import { compareDates, fyEnd, isFinancialYear, todayIST } from "@/lib/domain/fy";
import { fromPaise } from "@/lib/domain/money";
import { sortRealisationRows } from "@/lib/domain/realisation";
import { loadRealisation } from "@/lib/data/realisation";
import { writeXlsx, type XlsxSheet } from "@/server/exports/revenue-ledger";

/**
 * GET /fee-realisation/export?fy=2026-27
 *
 * Fee realisation for an FY as Excel (§7.9.10): a summary, every engagement (agreed, invoiced,
 * collected, billing %, realisation %, periods not invoiced) and the full leakage list. Partners
 * and Managers only (§4.1), at two-step sign-in (§12); writes an export_run audit row first.
 * Errors answer with the JSON contract and a Ref.
 */
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const pct = (v: number | null) => (v === null ? null : v);

export async function GET(request: NextRequest) {
  let userId: string | null = null;
  try {
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role !== "partner" && user.role !== "manager") return json({ ok: false, error: "Only Partners and Managers export fee realisation.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }

    const fy = request.nextUrl.searchParams.get("fy") ?? "";
    if (!isFinancialYear(fy)) return json({ ok: false, error: "Choose a financial year, for example 2026-27.", code: "validation" }, 400);
    const today = todayIST();
    const asOf = compareDates(fyEnd(fy), today) < 0 ? fyEnd(fy) : today;

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "fee_realisation",
      p_resource_id: fy,
      p_action: "collections.fee_realisation_xlsx",
      p_details: { financial_year: fy },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const report = await loadRealisation(supabase, fy, today);
    const rows = sortRealisationRows(report.rows, "client", "asc");
    const leakagePaise = report.leakage.reduce((s, l) => s + l.agreedPaise, 0);

    const summary: XlsxSheet = {
      name: "Summary",
      freeze: false,
      preamble: [
        [`Fee realisation, FY ${fy}, as of ${formatDate(asOf)}`],
        [`${rows.length} rows: ${rows.filter((r) => r.engagementId).length} engagements and ${rows.filter((r) => !r.engagementId).length} groups of invoices not tied to an engagement. ${report.leakage.length} ended periods with no invoice.`],
        ["Agreed: the fee in force for each billing period that has started. Invoiced: fees on issued invoices, without GST or reimbursements, less credit notes. Collected: received plus TDS against those fees."],
        [],
      ],
      headers: ["Figure", "Amount (₹)"],
      rows: [
        ["Agreed so far", fromPaise(report.totals.agreedPaise)],
        ["Invoiced", fromPaise(report.totals.invoicedPaise)],
        ["Collected", fromPaise(report.totals.collectedPaise)],
        ["Agreed and not invoiced (ended periods)", fromPaise(leakagePaise)],
        ["Billing % (invoiced of agreed)", pct(report.totals.billingPercent)],
        ["Realisation % (collected of invoiced)", pct(report.totals.realisationPercent)],
      ],
      moneyColumns: [1],
      widths: [48, 18],
    };

    const engagements: XlsxSheet = {
      name: "Engagements",
      headers: ["Client", "Code", "Engagement", "Cycle", "Active", "Agreed (₹)", "Invoiced (₹)", "Collected (₹)", "Billing %", "Realisation %", "Periods not invoiced"],
      rows: rows.map((r) => [
        r.clientName,
        r.clientCode,
        r.engagementId ? r.serviceLabel : `${r.serviceLabel} (not tied to an engagement)`,
        r.cycleLabel ?? "",
        r.engagementId ? (r.active ? "Yes" : "No") : "",
        fromPaise(r.agreedPaise),
        fromPaise(r.invoicedPaise),
        fromPaise(r.collectedPaise),
        pct(r.billingPercent),
        pct(r.realisationPercent),
        r.leakagePeriods,
      ]),
      moneyColumns: [5, 6, 7],
      widths: [32, 12, 30, 12, 8, 16, 16, 16, 11, 13, 12],
    };

    const leakage: XlsxSheet = {
      name: "Not invoiced",
      headers: ["Client", "Code", "Engagement", "Period", "From", "To", "Agreed (₹)"],
      rows: report.leakage.map((l) => [l.clientName, l.clientCode, l.serviceLabel, l.periodLabel, formatDate(l.periodStart), formatDate(l.periodEnd), fromPaise(l.agreedPaise)]),
      moneyColumns: [6],
      widths: [32, 12, 30, 14, 14, 14, 16],
    };

    const bytes = await writeXlsx([summary, engagements, leakage], { title: `Fee realisation FY ${fy}` });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="taxwise-fee-realisation-FY-${fy}.xlsx"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:fee-realisation:export", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
