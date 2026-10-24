import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { istDateOf, taxYearLabel, todayIST } from "@/lib/domain/fy";
import { formatINR, toPaise } from "@/lib/domain/money";
import { EMPTY, formatDate, formatDateTime } from "@/lib/format";
import {
  AUDIT_STAGE_LABELS,
  AUDIT_STEPS,
  AUDIT_TYPE_LABELS,
  MATERIALITY_BASIS_LABELS,
  REPORT_TYPE_LABELS,
  STEP_STATE_LABELS,
  fileAssemblyCountdown,
  isAuditStage,
  isAuditType,
  stepApplies,
  stepState,
} from "@/lib/domain/audit-stages";
import { auditYearLabel } from "@/lib/schemas/audits";
import { getAuditChecklistExport, type AuditDetail } from "@/lib/data/audits";
import { writeXlsx, type XlsxSheet } from "@/server/exports/revenue-ledger";

/**
 * GET /api/exports/audit-checklist/<auditId>
 *
 * The audit engagement checklist export (§11, §6.9, §7.15.5) as Excel: the engagement (team,
 * materiality, report, UDIN, the SA 230 assembly date, retention), every step of the SA checklist
 * with its references, status and preparer and reviewer sign-offs, the evidence tagged to each step
 * (amendments after archive marked), and the stage log with the engagement partner's approvals.
 * Partners and Managers only (§4.1, RLS 0033), at two-step sign-in (§12); an export_run audit row is
 * written first. Errors answer with the JSON contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const rupees = (v: number | null | undefined) => (v === null || v === undefined ? EMPTY : formatINR(toPaise(v)));
const day = (v: string | null | undefined) => (v ? formatDate(v.length > 10 ? istDateOf(v) : v) : EMPTY);

function sheets(d: AuditDetail, today: string): XlsxSheet[] {
  const e = d.engagement;
  const m = d.materiality;
  const countdown = fileAssemblyCountdown({ reportDate: e.report_date, archivedOn: e.archived_at ? istDateOf(e.archived_at) : null, today }, d.params);
  const assembly =
    countdown.state === "no_report"
      ? "No report date yet"
      : countdown.state === "assembled"
        ? "Assembled on time"
        : countdown.state === "assembled_late"
          ? `Assembled ${countdown.daysLate} days late`
          : countdown.state === "overdue"
            ? `${countdown.daysLate} days overdue`
            : `${countdown.daysLeft} days left`;
  const name = (id: string | null) => (id ? (d.names[id] ?? "Someone") : EMPTY);

  const engagement: XlsxSheet = {
    name: "Engagement",
    freeze: false,
    headers: ["Item", "Value"],
    widths: [34, 70],
    rows: [
      ["Client", `${d.client.display_name} (${d.client.client_code})`],
      ["Audit", AUDIT_TYPE_LABELS[d.auditType]],
      ["Year", auditYearLabel(d.auditType, e.financial_year, taxYearLabel)],
      ["Stage", AUDIT_STAGE_LABELS[d.stage]],
      ["Engagement partner", d.partner?.name ?? EMPTY],
      ["Review manager", d.reviewManager?.name ?? EMPTY],
      ["Previous auditor", e.had_previous_auditor === null ? "Not answered" : e.had_previous_auditor ? "Yes" : "No (first audit by a CA)"],
      ["Needs a peer-reviewed auditor", e.requires_peer_reviewed_auditor ? "Yes" : "No"],
      ["Accepted on", day(e.accepted_on)],
      ["Materiality basis (SA 320)", m ? `${MATERIALITY_BASIS_LABELS[m.basis]}: ${rupees(m.base_amount)} at ${m.percent}%` : "Not recorded"],
      ["Overall materiality", m ? rupees(m.overall) : EMPTY],
      ["Performance materiality", m ? `${rupees(m.performance)} (${m.performance_percent}% of overall)` : EMPTY],
      ["Clearly trivial", m ? `${rupees(m.trivial)} (${m.trivial_percent}% of overall)` : EMPTY],
      ["Materiality rationale", m?.rationale ?? EMPTY],
      ["Report type", e.report_type && e.report_type in REPORT_TYPE_LABELS ? REPORT_TYPE_LABELS[e.report_type as keyof typeof REPORT_TYPE_LABELS] : EMPTY],
      ["Report date", day(e.report_date)],
      ["UDIN", d.linkedUdin?.udin ?? EMPTY],
      ["CARO 2020 applies", d.auditType === "statutory_companies_act" ? (e.caro_applicable === null ? "Not decided" : e.caro_applicable ? "Yes" : "No") : "Not a company audit"],
      ["File assembly due (SA 230)", day(e.file_assembly_due)],
      ["File assembly", assembly],
      ["Archived on", e.archived_at ? formatDateTime(e.archived_at) : EMPTY],
      ["Retain until (SQC 1)", day(e.retain_until)],
      ["Exported on", formatDate(today)],
    ],
  };

  const evidenceByStep = new Map<string, string[]>();
  for (const ev of d.evidence) evidenceByStep.set(ev.step_key, [...(evidenceByStep.get(ev.step_key) ?? []), ev.title]);

  const checklist: XlsxSheet = {
    name: "Checklist",
    headers: ["Stage", "Step", "Standards", "Evidence needed", "Status", "Prepared by", "Prepared on", "Reviewed by", "Reviewed on", "Not applicable because", "Note", "Working papers"],
    widths: [16, 46, 28, 10, 22, 20, 20, 20, 20, 30, 30, 46],
    rows: AUDIT_STEPS.filter((s) => stepApplies(s, d.auditType)).map((s) => {
      const so = d.checklist[s.key];
      return [
        AUDIT_STAGE_LABELS[s.stage],
        s.title,
        s.sa.join(", "),
        s.evidenceRequired ? "Yes" : "No",
        STEP_STATE_LABELS[stepState(so)],
        name(so?.preparedBy ?? null),
        so?.preparedAt ? formatDateTime(so.preparedAt) : EMPTY,
        name(so?.reviewedBy ?? null),
        so?.reviewedAt ? formatDateTime(so.reviewedAt) : EMPTY,
        so?.notApplicable ? (so.naReason ?? EMPTY) : EMPTY,
        so?.note && !so.notApplicable ? so.note : EMPTY,
        (evidenceByStep.get(s.key) ?? []).join("; ") || EMPTY,
      ];
    }),
  };

  const stepTitle = new Map(AUDIT_STEPS.map((s) => [s.key, s]));
  const evidence: XlsxSheet = {
    name: "Working papers",
    headers: ["Stage", "Step", "Document", "File", "Category", "Added by", "Added on", "Amendment after archive", "Amendment note"],
    widths: [16, 40, 40, 30, 14, 20, 20, 12, 40],
    rows: d.evidence.map((ev) => {
      const s = stepTitle.get(ev.step_key);
      return [
        s ? AUDIT_STAGE_LABELS[s.stage] : EMPTY,
        s?.title ?? ev.step_key,
        ev.deleted ? `${ev.title} (deleted from the vault)` : ev.title,
        ev.file_name,
        ev.category,
        ev.added_by_name ?? EMPTY,
        formatDateTime(ev.added_at),
        ev.is_amendment ? "Yes" : "No",
        ev.amendment_note ?? EMPTY,
      ];
    }),
  };

  const log: XlsxSheet = {
    name: "Stage log",
    headers: ["From", "To", "Approved by", "When", "Note", "Warnings at the time"],
    widths: [16, 16, 22, 20, 46, 46],
    rows: d.log.map((l) => {
      const warnings = Array.isArray(l.warnings)
        ? (l.warnings as Array<{ message?: unknown }>).map((w) => (typeof w?.message === "string" ? w.message : "")).filter(Boolean).join("; ")
        : "";
      return [
        isAuditStage(l.from_stage) ? AUDIT_STAGE_LABELS[l.from_stage] : l.from_stage,
        isAuditStage(l.to_stage) ? AUDIT_STAGE_LABELS[l.to_stage] : l.to_stage,
        l.approved_by_name ?? EMPTY,
        formatDateTime(l.at),
        l.note ?? EMPTY,
        warnings || EMPTY,
      ];
    }),
  };
  return [engagement, checklist, evidence, log];
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

    const today = todayIST();
    const detail = await getAuditChecklistExport(supabase, auditId, today);
    if (!detail || !isAuditType(detail.auditType)) return json({ ok: false, error: "That audit engagement doesn't exist, or you can't see it.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "audit_engagement",
      p_resource_id: auditId,
      p_action: "audits.checklist_xlsx",
      p_details: { audit_type: detail.auditType, financial_year: detail.engagement.financial_year, stage: detail.stage, evidence: detail.evidence.length },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const bytes = await writeXlsx(sheets(detail, today), { title: `Audit checklist · ${detail.client.display_name} · FY ${detail.engagement.financial_year}` });
    const file = `taxwise-audit-checklist-${String(detail.client.client_code).replace(/[^A-Za-z0-9-]+/g, "-")}-${detail.engagement.financial_year}.xlsx`;
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
    const ref = logUnexpected(err, { source: "api:exports:audit-checklist", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
