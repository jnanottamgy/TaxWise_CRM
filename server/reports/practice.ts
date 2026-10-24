import "server-only";

import { ceilingWarning, CEILING_DEFAULTS } from "@/lib/domain/ceiling";
import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult, ReportRow, ReportStatusCell } from "@/components/reports/report-types";
import { callReport, rate, reportHeader, SCREEN_LIST_ROWS, type ReportLoader } from "@/server/reports/shared";

/**
 * Practice (§7.16): "UDIN register (period), tax-audit ceiling by partner, DSC/registration
 * expiries, engagement letters coverage". The UDIN register lists UDINs for reports signed in the
 * period, flagging those generated more than the allowed days after signing (60, §6.8); the ceiling
 * counts each partner's tax audits for the FY of the period's end, by the date signed, with audits
 * signed elsewhere, against the ceiling in force (tax_audit_ceiling_view, §6.8); expiries are active
 * DSCs and registrations past or within 90 days of expiry; coverage is active clients with an
 * active service and an engagement letter for the FY at Issued or Signed. report_practice (0213).
 */

type Raw = {
  today: string;
  fy: string;
  udin: {
    total: number;
    late: number;
    counted: number;
    rows: Array<{ id: string; udin: string; client_id: string | null; client_name: string | null; document_type: string; report_form: string | null; document_date: string; signed_on: string; generated_on: string; is_revised: boolean; counts: boolean | null; signed_by: string | null; days_to_generate: number; allowed_days: number }>;
  };
  ceiling: Array<{ member_profile_id: string; name: string | null; membership_no: string | null; signed_in_firm: number; signed_elsewhere: number; total: number; ceiling: number | null; warning: string | null }>;
  expiries: { expired: number; next_30: number; next_90: number; total: number; rows: Array<{ kind: "dsc" | "registration"; id: string; client_id: string; client_name: string; label: string; detail: string | null; expiry_date: string; days_left: number }> };
  letters: {
    clients: number;
    signed: number;
    issued: number;
    draft: number;
    declined: number;
    expired: number;
    none: number;
    missing_total: number;
    missing: Array<{ client_id: string; display_name: string; client_code: string; owner_name: string | null; letter_status: string | null }>;
  };
};

const FORM_LABEL: Record<string, string> = {
  "3CA": "Form 3CA",
  "3CB_44AB_a": "Form 3CB, s.44AB(a)",
  "3CB_44AB_b": "Form 3CB, s.44AB(b)",
  "3CB_combined": "Form 3CB, combined",
  "3CB_44AB_c": "Form 3CB, s.44AB(c)",
  "3CB_44AB_d": "Form 3CB, s.44AB(d)",
  "3CB_44AB_e": "Form 3CB, s.44AB(e)",
  FORM_26: "Form 26",
  audit_report: "Audit report",
  certificate: "Certificate",
  gst_audit: "GST audit",
  other: "Other",
};

const LETTER: Record<string, ReportStatusCell> = {
  none: { label: "No letter", tone: "danger", meaning: "No engagement letter for the FY yet. Issue one before the work goes far." },
  draft: { label: "Draft", tone: "muted", meaning: "Draft: written but not issued to the client." },
  declined: { label: "Declined", tone: "danger", meaning: "Declined: the client didn't sign it. Agree the terms again." },
  expired: { label: "Expired", tone: "muted", meaning: "Expired: the letter has run out. Renew it for the FY." },
};

function ceilingCell(total: number, ceiling: number | null, warning: string | null): ReportStatusCell {
  const w = warning ?? (ceiling ? ceilingWarning(total, { ...CEILING_DEFAULTS, taxAuditCeiling: ceiling }) : null);
  if (w === "over") return { label: "Over the ceiling", tone: "danger", meaning: "More tax audits than the ceiling allows for the FY. The UDIN portal refuses more." };
  if (w === "at_ceiling") return { label: "At the ceiling", tone: "danger", meaning: "No more tax audits can be signed this FY." };
  if (w === "near") return { label: "Near the ceiling", tone: "warning", meaning: "Close to the ceiling: plan who signs the rest of the year's audits." };
  return { label: "Within the ceiling", tone: "success", meaning: "Room for more tax audits this FY." };
}

export const loadPracticeReport: ReportLoader = async (supabase, f, ctx) => {
  const page = ctx.forExport ? { offset: 0, limit: 20000 } : { offset: (f.page - 1) * f.pageSize, limit: f.pageSize };
  const [header, r] = await Promise.all([reportHeader(supabase, "practice", f, ctx), callReport<Raw>(supabase, "report_practice", reportRpcParams(f, page))]);
  const L = r.letters;
  const covered = L.signed + L.issued;

  const udins: ReportRow[] = r.udin.rows.map((u) => {
    const late = u.days_to_generate > u.allowed_days;
    return {
      udin: u.udin,
      client: u.client_id ? { text: u.client_name ?? "Client", href: `/clients/${u.client_id}?tab=registers` } : "No client",
      document: [u.document_type, u.report_form ? FORM_LABEL[u.report_form] ?? u.report_form : null, u.is_revised ? "Revised" : null].filter(Boolean).join(" · "),
      signed_on: u.signed_on,
      generated_on: u.generated_on,
      gap: late
        ? { label: `${u.days_to_generate} days`, tone: "danger", meaning: `Generated ${u.days_to_generate} days after signing; UDINs are due within ${u.allowed_days} days of signing.` }
        : { label: `${u.days_to_generate} ${u.days_to_generate === 1 ? "day" : "days"}`, tone: "muted", meaning: `Generated within the ${u.allowed_days} days allowed after signing.` },
      signed_by: u.signed_by ?? "",
    } satisfies ReportRow;
  });

  const ceiling: ReportRow[] = r.ceiling.map((c) => ({
    partner: c.name ? `${c.name}${c.membership_no ? ` (M. No. ${c.membership_no})` : ""}` : "A member no longer listed",
    in_firm: c.signed_in_firm,
    elsewhere: c.signed_elsewhere,
    total: c.total,
    ceiling: c.ceiling,
    left: c.ceiling === null ? null : Math.max(0, c.ceiling - c.total),
    status: ceilingCell(c.total, c.ceiling, c.warning),
  }));

  const expiries = (ctx.forExport ? r.expiries.rows : r.expiries.rows.slice(0, SCREEN_LIST_ROWS)).map((e) => ({
    what: e.kind === "dsc" ? `DSC · ${e.detail ?? "holder not recorded"}` : `${e.label.replace(/_/g, " ")} · ${e.detail ?? ""}`.trim(),
    client: { text: e.client_name, href: `/clients/${e.client_id}?tab=registers` },
    expiry: e.expiry_date,
    left:
      e.days_left < 0
        ? ({ label: `Expired ${-e.days_left} ${-e.days_left === 1 ? "day" : "days"} ago`, tone: "danger", meaning: "Past its expiry date and still marked active. Renew it or mark it expired." } satisfies ReportStatusCell)
        : e.days_left <= 30
          ? ({ label: e.days_left === 0 ? "Expires today" : `In ${e.days_left} ${e.days_left === 1 ? "day" : "days"}`, tone: "warning", meaning: "Expires within 30 days. Start the renewal." } satisfies ReportStatusCell)
          : ({ label: `In ${e.days_left} days`, tone: "info", meaning: "Expires within 90 days." } satisfies ReportStatusCell),
  }));

  const missing = (ctx.forExport ? L.missing : L.missing.slice(0, SCREEN_LIST_ROWS)).map((m) => ({
    client: { text: m.display_name, href: `/clients/${m.client_id}?tab=engagement`, sub: m.client_code },
    owner: m.owner_name ?? "No owner",
    letter: LETTER[m.letter_status ?? "none"] ?? LETTER.none,
  }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: `Engagement letters · FY ${r.fy}`, kind: "percent", value: rate(covered, L.clients), sub: `${covered} of ${L.clients} active clients covered`, href: `/engagement-letters?view=missing&year=${r.fy}` },
      { label: "UDINs in the period", kind: "count", value: r.udin.total, sub: `${r.udin.counted} count towards the ceiling`, href: "/registers?tab=udin" },
      { label: "UDINs generated late", kind: "count", value: r.udin.late, sub: "More than the allowed days after signing" },
      { label: "DSCs and registrations", kind: "count", value: r.expiries.next_90 + r.expiries.expired, sub: `${r.expiries.expired} expired, ${r.expiries.next_30} within 30 days`, href: "/registers?tab=dsc" },
    ],
    sections: [
      {
        id: "udin",
        title: "UDIN register",
        description: "UDINs for reports signed in the period, newest first. Late: generated more than the allowed days after signing.",
        columns: [
          { key: "udin", header: "UDIN", kind: "text", mobile: "primary" },
          { key: "client", header: "Client", kind: "link", mobile: "secondary" },
          { key: "document", header: "Document", kind: "text", hideBelow: "lg" },
          { key: "signed_on", header: "Signed on", kind: "date", mobile: "trailing" },
          { key: "generated_on", header: "Generated on", kind: "date", hideBelow: "xl" },
          { key: "gap", header: "Days to generate", kind: "status", mobile: "secondary" },
          { key: "signed_by", header: "Signed by", kind: "text", hideBelow: "lg" },
        ],
        rows: udins,
        pager: ctx.forExport ? null : { page: f.page, pageSize: f.pageSize, total: r.udin.total },
        total: r.udin.total,
        empty: "No UDIN was logged for a report signed in this period.",
      },
      {
        id: "ceiling",
        title: `Tax-audit ceiling · FY ${r.fy}`,
        description: "Tax audit reports counted for each partner by the date signed, with audits they signed elsewhere. Revised reports and branch audits of the same assessee don't count again.",
        columns: [
          { key: "partner", header: "Partner", kind: "text", mobile: "primary" },
          { key: "in_firm", header: "Signed here", kind: "count", mobile: "secondary" },
          { key: "elsewhere", header: "Signed elsewhere", kind: "count", hideBelow: "lg" },
          { key: "total", header: "Counted", kind: "count", mobile: "trailing" },
          { key: "ceiling", header: "Ceiling", kind: "count", hideBelow: "lg" },
          { key: "left", header: "Left", kind: "count", mobile: "secondary" },
          { key: "status", header: "Status", kind: "status", mobile: "secondary" },
        ],
        rows: ceiling,
        empty: "No partner has signed a tax audit this FY.",
        more: { label: "Open the UDIN register", href: "/registers?tab=udin" },
      },
      {
        id: "expiries",
        title: "DSC and registration expiries",
        description: "Active DSCs and registrations already past their expiry date or expiring within 90 days, soonest first.",
        columns: [
          { key: "what", header: "DSC or registration", kind: "text", mobile: "primary" },
          { key: "client", header: "Client", kind: "link", mobile: "secondary" },
          { key: "expiry", header: "Expiry date", kind: "date", hideBelow: "lg" },
          { key: "left", header: "When", kind: "status", mobile: "trailing" },
        ],
        rows: expiries,
        total: r.expiries.total,
        more: r.expiries.total > expiries.length ? { label: "Open the DSC register", href: "/registers?tab=dsc" } : null,
        empty: "Nothing expires in the next 90 days.",
        half: true,
      },
      {
        id: "letters",
        title: `Engagement letters · FY ${r.fy}`,
        description: "Active clients with an active service, by where their letter for the FY stands; the clients still to cover are listed.",
        columns: [
          { key: "client", header: "Client", kind: "link", mobile: "primary" },
          { key: "owner", header: "Owner", kind: "text", hideBelow: "lg" },
          { key: "letter", header: "Letter", kind: "status", mobile: "trailing" },
        ],
        rows: missing,
        totals: { client: `Signed ${L.signed} · Issued ${L.issued} · Draft ${L.draft} · Declined ${L.declined} · Expired ${L.expired} · None ${L.none}`, owner: null, letter: null },
        total: L.missing_total,
        more: L.missing_total > missing.length ? { label: `View all ${L.missing_total} without a letter`, href: `/engagement-letters?view=missing&year=${r.fy}` } : null,
        empty: "Every active client has an issued or signed letter for the FY.",
        half: true,
      },
    ],
  };
  return result;
};
