import { NextResponse, type NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getSelectedFy } from "@/lib/fy-context";
import { todayIST } from "@/lib/domain/fy";
import { REPORT_FORMATS, isReportSlug, parseReportFilters, reportRpcParams, type ReportFormat } from "@/lib/schemas/reports";
import { getFirmProfile } from "@/server/firm";
import { loadReport } from "@/server/reports";
import { buildReportWorkbook } from "@/server/reports/excel";
import { buildReportPdf } from "@/server/reports/pdf";
import { attachment, auditExport, gateExport, jsonResponse } from "@/server/reports/route-gate";

/**
 * GET /api/exports/reports/<slug>?format=xlsx|pdf&<the report's filters>
 *
 * A report from the reports centre as Excel or PDF (§7.16), with every row (not the screen's page),
 * built from the same ReportResult the page shows. Partners and Managers only (§4.1; the database
 * refuses anyone else too), at two-step sign-in (§12); every export writes an export_run audit row
 * first. The period defaults to the FY in the top bar, as on the page. Errors answer with the JSON
 * contract and a Ref.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  let userId: string | null = null;
  try {
    const { slug } = await ctx.params;
    const gate = await gateExport(["partner", "manager"], "Reports are for Partners and Managers.");
    if (!gate.ok) return gate.response;
    const { user, supabase } = gate;
    userId = user.id;
    if (!isReportSlug(slug)) return jsonResponse({ ok: false, error: "There's no such report.", code: "not_found" }, 404);

    const sp = request.nextUrl.searchParams;
    const rawFormat = sp.get("format") ?? "xlsx";
    if (!(REPORT_FORMATS as readonly string[]).includes(rawFormat)) return jsonResponse({ ok: false, error: "Choose Excel or PDF.", code: "validation" }, 400);
    const format = rawFormat as ReportFormat;

    const today = todayIST();
    const filters = parseReportFilters(sp, slug, { selectedFy: await getSelectedFy(), today });
    if (filters.periodError) return jsonResponse({ ok: false, error: filters.periodError, code: "validation" }, 400);

    await auditExport(supabase, request, {
      resourceType: "report",
      resourceId: slug,
      action: `reports.${slug}_${format}`,
      details: { format, ...reportRpcParams(filters) },
    });

    const [report, firm] = await Promise.all([loadReport(supabase, filters, { today, forExport: true }), getFirmProfile(supabase)]);
    const base = `taxwise-${slug}-report-${filters.from}-to-${filters.to}`;
    if (format === "pdf") {
      const bytes = await buildReportPdf({ firm, report, generatedBy: user.fullName });
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": attachment(`${base}.pdf`),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const bytes = await buildReportWorkbook(report, { firmName: firm.firmName, generatedBy: user.fullName });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": attachment(`${base}.xlsx`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:reports", userId });
    return jsonResponse({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
