import { NextResponse, type NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { CSV_BOM, csvRow } from "@/lib/domain/csv";
import { formatDate } from "@/lib/format";
import { AUDIT_FILTERS, AUDIT_SORTABLE, auditQueryParams, listAuditLog, type AuditRow } from "@/lib/data/audit-log";
import { parseTableParams } from "@/components/app/data-table/params";
import { auditEventLabel, humanise, roleLabel } from "@/components/audit-log/audit-format";
import { attachment, auditExport, gateExport, jsonResponse } from "@/server/reports/route-gate";

/**
 * GET /api/exports/audit-log?<the page's filters>
 *
 * The audit log as CSV (§7.20 "CSV export"): every entry the filters match, oldest first, streamed in
 * pages of 1,000 from audit_log_page (0212), so a long log never sits in memory. Partners only
 * (§4.1), at two-step sign-in (§12); the export_run audit row is written before the first byte. Cells
 * that would run as a spreadsheet formula are quoted (lib/domain/csv.ts). Errors before the stream
 * starts answer with the JSON contract and a Ref.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH = 1000;
const MAX_ROWS = 500_000;

const HEADERS = ["At (IST)", "At (ISO)", "Event", "Outcome", "Person", "Email", "Role", "Record type", "Record id", "Action", "IP address", "Browser", "Reason", "Details"];

function istClock(at: string): string {
  const d = new Date(new Date(at).getTime() + 330 * 60 * 1000);
  return `${formatDate(at)} ${d.toISOString().slice(11, 19)}`;
}

function line(r: AuditRow): string {
  return csvRow([
    istClock(r.at),
    r.at,
    auditEventLabel(r.event),
    r.success ? "Succeeded" : "Failed",
    r.user_name ?? (r.user_id ? "" : "System"),
    r.user_email ?? "",
    roleLabel(r.user_role),
    r.resource_type ? humanise(r.resource_type) : "",
    r.resource_id ?? "",
    r.action ?? "",
    r.ip ?? "",
    r.user_agent ?? "",
    r.error ?? "",
    r.details && typeof r.details === "object" && Object.keys(r.details).length ? JSON.stringify(r.details) : "",
  ]);
}

export async function GET(request: NextRequest) {
  let userId: string | null = null;
  try {
    const gate = await gateExport(["partner"], "Only Partners export the audit log.");
    if (!gate.ok) return gate.response;
    const { user, supabase } = gate;
    userId = user.id;

    const t = parseTableParams(request.nextUrl.searchParams, { sortable: AUDIT_SORTABLE, defaultSort: { sort: "at", dir: "desc" }, filters: AUDIT_FILTERS });
    const today = todayIST();
    const params = { ...auditQueryParams(t, today), dir: "asc" };
    const first = await listAuditLog(supabase, params, { offset: 0, limit: 1 });

    await auditExport(supabase, request, {
      resourceType: "audit_log",
      resourceId: null,
      action: "audit_log.export_csv",
      details: { filters: params, rows: Math.min(first.total, MAX_ROWS) },
    });

    const total = Math.min(first.total, MAX_ROWS);
    const encoder = new TextEncoder();
    let offset = 0;
    let started = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (!started) {
            started = true;
            controller.enqueue(encoder.encode(CSV_BOM + csvRow(HEADERS)));
            if (total === 0) controller.close();
            return;
          }
          if (offset >= total) {
            controller.close();
            return;
          }
          const page = await listAuditLog(supabase, params, { offset, limit: Math.min(BATCH, total - offset) });
          offset += page.rows.length;
          if (page.rows.length === 0) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(page.rows.map(line).join("")));
        } catch (err) {
          logUnexpected(err, { source: "api:exports:audit-log:stream", userId });
          controller.error(err);
        }
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": attachment(`taxwise-audit-log-${today}.csv`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-TaxWise-Rows": String(total),
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:audit-log", userId });
    return jsonResponse({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
