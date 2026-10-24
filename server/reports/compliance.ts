import "server-only";

import { COMPLIANCE_TYPE_LABELS, isEnumValue } from "@/lib/domain/enums";
import { addDays, compareDates } from "@/lib/domain/fy";
import { formatDate, formatDateShort } from "@/lib/format";
import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult, ReportRow } from "@/components/reports/report-types";
import { callReport, rate, reportHeader, type ReportLoader } from "@/server/reports/shared";

/**
 * Compliance (§7.16): "filed on time vs late per return type and period; upcoming load; overdue by
 * owner". Statutory compliance events only (internal prep steps aren't returns), cancelled ones left
 * out. On time = marked completed on or before the due date (IST); late = after it; overdue = still
 * pending past the due date (derived, §0.1 rule 10). report_compliance (0213) counts it in SQL.
 */

type Raw = {
  today: string;
  kpis: { due: number; filed: number; on_time: number; late: number; overdue_now: number; due_next_30: number };
  by_return: Array<{ type: string; form_code: string | null; filing_period: string; period_start: string | null; first_due: string; last_due: string; due: number; filed: number; on_time: number; late: number; overdue: number; not_yet_due: number }>;
  upcoming: Array<{ week_start: string; total: number; gst: number; tds: number; income_tax: number; roc: number; other: number }>;
  overdue_by_owner: Array<{ owner_id: string | null; owner_name: string | null; overdue: number; clients: number; oldest_due: string; days_overdue: number }>;
};

function returnLabel(type: string, formCode: string | null): string {
  if (formCode) return formCode;
  return isEnumValue("compliance_type", type) ? COMPLIANCE_TYPE_LABELS[type] : type;
}

export const loadComplianceReport: ReportLoader = async (supabase, f, ctx) => {
  const [header, r] = await Promise.all([reportHeader(supabase, "compliance", f, ctx), callReport<Raw>(supabase, "report_compliance", reportRpcParams(f))]);
  const k = r.kpis;
  const onTimeRate = rate(k.on_time, k.on_time + k.late);

  const byReturn: ReportRow[] = r.by_return.map((b) => ({
    form: returnLabel(b.type, b.form_code),
    period: b.filing_period || (b.first_due === b.last_due ? `Due ${formatDate(b.first_due)}` : `Due ${formatDateShort(b.first_due)} – ${formatDate(b.last_due)}`),
    due: b.due,
    filed: b.filed,
    on_time: b.on_time,
    late: b.late,
    overdue: b.overdue,
    open: b.not_yet_due,
    rate: rate(b.on_time, b.on_time + b.late),
  }));
  const sum = (key: keyof Raw["by_return"][number]) => r.by_return.reduce((n, b) => n + Number(b[key] ?? 0), 0);

  // The same returns grouped by form across periods: the year's picture per return.
  const forms = new Map<string, { due: number; filed: number; on_time: number; late: number; overdue: number }>();
  for (const b of r.by_return) {
    const key = returnLabel(b.type, b.form_code);
    const e = forms.get(key) ?? { due: 0, filed: 0, on_time: 0, late: 0, overdue: 0 };
    e.due += b.due;
    e.filed += b.filed;
    e.on_time += b.on_time;
    e.late += b.late;
    e.overdue += b.overdue;
    forms.set(key, e);
  }
  const byForm: ReportRow[] = [...forms.entries()]
    .sort((a, b) => b[1].due - a[1].due || a[0].localeCompare(b[0]))
    .map(([form, e]) => ({ form, due: e.due, filed: e.filed, on_time: e.on_time, late: e.late, overdue: e.overdue, rate: rate(e.on_time, e.on_time + e.late) }));

  const upcoming: ReportRow[] = r.upcoming.map((u) => ({
    week: compareDates(u.week_start, ctx.today) <= 0 ? `This week (${formatDateShort(u.week_start)})` : `Week of ${formatDateShort(u.week_start)}`,
    total: u.total,
    gst: u.gst,
    tds: u.tds,
    income_tax: u.income_tax,
    roc: u.roc,
    other: u.other,
  }));

  const owners: ReportRow[] = r.overdue_by_owner.map((o) => ({
    owner: o.owner_name ?? "No owner",
    overdue: o.overdue,
    clients: o.clients,
    oldest: o.oldest_due,
    days: o.days_overdue,
  }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Filed on time", kind: "percent", value: onTimeRate, sub: k.on_time + k.late ? `${k.on_time} of ${k.on_time + k.late} returns filed` : "Nothing filed in the period yet" },
      { label: "Due in the period", kind: "count", value: k.due, sub: `${k.filed} filed` },
      { label: "Filed late", kind: "count", value: k.late, sub: "After the due date" },
      { label: "Overdue now", kind: "count", value: k.overdue_now, sub: "Any period, not yet filed", href: "/filings?status=overdue" },
      { label: "Due in the next 30 days", kind: "count", value: k.due_next_30, sub: `To ${formatDate(addDays(ctx.today, 30))}`, href: "/calendar" },
    ],
    sections: [
      {
        id: "by-form",
        title: "On time and late, by return",
        description: "Every period of each return due in the period, together.",
        columns: [
          { key: "form", header: "Return", kind: "text", mobile: "primary" },
          { key: "due", header: "Due", kind: "count", mobile: "secondary" },
          { key: "filed", header: "Filed", kind: "count", mobile: "secondary" },
          { key: "on_time", header: "On time", kind: "count" },
          { key: "late", header: "Late", kind: "count", mobile: "secondary" },
          { key: "overdue", header: "Overdue", kind: "count", mobile: "secondary" },
          { key: "rate", header: "On-time rate", kind: "percent", mobile: "trailing" },
        ],
        rows: byForm,
        totals: byForm.length > 1 ? { form: "All returns", due: sum("due"), filed: sum("filed"), on_time: sum("on_time"), late: sum("late"), overdue: sum("overdue"), rate: onTimeRate } : null,
        empty: "No statutory returns were due in this period.",
      },
      {
        id: "by-period",
        title: "On time and late, by return and period",
        description: "One row per return and filing period. Not yet due: due later in the period and still open.",
        columns: [
          { key: "form", header: "Return", kind: "text", mobile: "primary" },
          { key: "period", header: "Period", kind: "text", mobile: "secondary" },
          { key: "due", header: "Due", kind: "count", hideBelow: "lg" },
          { key: "filed", header: "Filed", kind: "count", mobile: "secondary" },
          { key: "on_time", header: "On time", kind: "count", hideBelow: "lg" },
          { key: "late", header: "Late", kind: "count", mobile: "secondary" },
          { key: "overdue", header: "Overdue", kind: "count" },
          { key: "open", header: "Not yet due", kind: "count", hideBelow: "xl" },
          { key: "rate", header: "On-time rate", kind: "percent", mobile: "trailing" },
        ],
        rows: byReturn,
        empty: "No statutory returns were due in this period.",
      },
      {
        id: "upcoming",
        title: "Upcoming load",
        description: "Returns still to file, by the week they fall due, for the next eight weeks.",
        columns: [
          { key: "week", header: "Week", kind: "text", mobile: "primary" },
          { key: "total", header: "Returns", kind: "count", mobile: "trailing" },
          { key: "gst", header: "GST", kind: "count", mobile: "secondary" },
          { key: "tds", header: "TDS", kind: "count", mobile: "secondary" },
          { key: "income_tax", header: "Income tax", kind: "count", mobile: "secondary" },
          { key: "roc", header: "ROC", kind: "count", hideBelow: "lg" },
          { key: "other", header: "Other", kind: "count", hideBelow: "lg" },
        ],
        rows: upcoming,
        empty: "Nothing falls due in the next eight weeks.",
        chart: { x: "week", y: "total", label: "Returns due", xLabel: "Week", format: "number" },
        half: true,
      },
      {
        id: "overdue",
        title: "Overdue by client owner",
        description: "Returns past their due date and not filed, by the owner of the client.",
        columns: [
          { key: "owner", header: "Owner", kind: "text", mobile: "primary" },
          { key: "overdue", header: "Overdue", kind: "count", mobile: "trailing" },
          { key: "clients", header: "Clients", kind: "count", mobile: "secondary" },
          { key: "oldest", header: "Oldest due date", kind: "date", mobile: "secondary" },
          { key: "days", header: "Longest overdue", kind: "days", hideBelow: "lg" },
        ],
        rows: owners,
        totals: owners.length > 1 ? { owner: "Everyone", overdue: r.overdue_by_owner.reduce((n, o) => n + o.overdue, 0), clients: null, oldest: null, days: null } : null,
        empty: "Nothing is overdue.",
        half: true,
      },
    ],
  };
  return result;
};
