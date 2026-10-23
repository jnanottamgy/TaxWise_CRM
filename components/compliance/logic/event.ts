/**
 * One deadline, read for display (§7.7, §3.6, §6.3, §6.7): its display status (the workflow, or
 * Overdue when an unfiled deadline is past its date), its family for the calendar colours, the
 * moves the viewer may make, the hints worth showing (Sunday, GSTR-1A / IMS before GSTR-3B, the GST
 * three-year filing bar, ROC late fees, extensions), and how it reads in the client report (on time,
 * late, overdue). Pure and client-safe; "today" is always a parameter.
 */
import type { ComplianceStatus, ComplianceType, ComplianceWorkflow } from "@/lib/domain/enums";
import { compareDates, diffDays, isDateString, type DateString } from "@/lib/domain/fy";
import { filingBarStatus, lateFeeAccrued, sundayHint, type FilingBarParams } from "@/lib/domain/statutory-calendar";
import { formatINR, type Paise } from "@/lib/domain/money";
import { formatDate } from "@/lib/format";
import type { AppRole } from "@/lib/auth/roles";

export type EventDisplay = "overdue" | ComplianceWorkflow | "cancelled";

/** Least done first: a cell holding several deadlines shows the one that needs attention. */
export const DISPLAY_RANK: Readonly<Record<EventDisplay, number>> = {
  overdue: 0,
  not_started: 1,
  documents_awaited: 2,
  in_progress: 3,
  under_review: 4,
  filed: 5,
  completed: 6,
  cancelled: 7,
};

export interface StatusLike {
  status: ComplianceStatus | string;
  workflow_status: ComplianceWorkflow | string;
  due_date: DateString;
}

export function isDone(e: Pick<StatusLike, "status" | "workflow_status">): boolean {
  return e.workflow_status === "filed" || e.workflow_status === "completed" || e.status === "completed";
}

/** The workflow step, or Overdue for a pending, unfiled deadline past its due date (derived, §3.6). */
export function eventDisplayStatus(e: StatusLike, today: DateString): EventDisplay {
  if (e.status === "cancelled") return "cancelled";
  if (isDone(e)) return e.workflow_status === "completed" ? "completed" : "filed";
  if (compareDates(e.due_date, today) < 0) return "overdue";
  return (e.workflow_status as ComplianceWorkflow) ?? "not_started";
}

/** The chip for a display status: overdue and cancelled come from compliance_status, the rest from the workflow. */
export function displayChip(d: EventDisplay): { kind: "compliance_status" | "compliance_workflow"; value: string } {
  if (d === "overdue" || d === "cancelled") return { kind: "compliance_status", value: d };
  return { kind: "compliance_workflow", value: d };
}

/** The least-done status of several deadlines, with how many are done. */
export function summariseStatuses(events: readonly StatusLike[], today: DateString): { display: EventDisplay; total: number; done: number } {
  let display: EventDisplay = "cancelled";
  let done = 0;
  let total = 0;
  for (const e of events) {
    const d = eventDisplayStatus(e, today);
    if (d === "cancelled") continue;
    total++;
    if (d === "filed" || d === "completed") done++;
    if (DISPLAY_RANK[d] < DISPLAY_RANK[display]) display = d;
  }
  return { display, total, done };
}

// -------------------------------------------------------------------------------------------------
// Families (calendar colour by type, §7.7)
// -------------------------------------------------------------------------------------------------

export type EventFamily = "gst" | "income_tax" | "tds" | "roc" | "payroll" | "firm";

export const EVENT_FAMILIES: readonly EventFamily[] = ["gst", "income_tax", "tds", "roc", "payroll", "firm"];

/** Label and dot classes (category hues, never the status colours: green, amber and red mean status). */
export const FAMILY_META: Readonly<Record<EventFamily, { label: string; dot: string }>> = {
  gst: { label: "GST", dot: "bg-info" },
  income_tax: { label: "Income tax", dot: "bg-gold" },
  tds: { label: "TDS", dot: "bg-violet" },
  roc: { label: "ROC", dot: "bg-text" },
  payroll: { label: "Payroll and other", dot: "bg-text-muted" },
  firm: { label: "Firm and internal", dot: "bg-transparent ring-[1.5px] ring-inset ring-text-muted" },
};

export function eventFamily(type: ComplianceType | string, formCode: string | null | undefined, isStatutory: boolean): EventFamily {
  if (!isStatutory) return "firm";
  switch (type) {
    case "gstr_1":
    case "gstr_3b":
      return "gst";
    case "itr":
    case "advance_tax":
    case "audit":
      return "income_tax";
    case "tds":
      return "tds";
    case "roc":
      return "roc";
    case "pf_esic":
    case "pt":
      return "payroll";
    default:
      return formCode && /^(GSTR|CMP|PMT|IFF)/i.test(formCode) ? "gst" : "payroll";
  }
}

// -------------------------------------------------------------------------------------------------
// Workflow moves (§7.7, mirrors change_compliance_workflow in 0126)
// -------------------------------------------------------------------------------------------------

export const WORKFLOW_ORDER: readonly ComplianceWorkflow[] = ["not_started", "documents_awaited", "in_progress", "under_review", "filed", "completed"];

export interface WorkflowMove {
  to: ComplianceWorkflow;
  /** Filing a client's statutory deadline with no filing record opens the §7.6.5 dialog instead. */
  needsFiling: boolean;
  /** Reopening (Filed/Completed → earlier) needs a reason. */
  needsReason: boolean;
  reopen: boolean;
}

export function workflowMoves(
  e: { workflow_status: ComplianceWorkflow; status: ComplianceStatus | string; is_statutory: boolean; client_id: string | null; has_filing: boolean },
  role: AppRole,
): WorkflowMove[] {
  if (e.status === "cancelled" || role === "client") return [];
  const manager = role === "partner" || role === "manager";
  const fromDone = e.workflow_status === "filed" || e.workflow_status === "completed";
  if (fromDone && !manager) return [];
  const out: WorkflowMove[] = [];
  for (const to of WORKFLOW_ORDER) {
    if (to === e.workflow_status) continue;
    const toDone = to === "filed" || to === "completed";
    if (toDone && !manager) continue;
    const reopen = fromDone && !toDone;
    out.push({
      to,
      needsFiling: toDone && !fromDone && e.client_id !== null && e.is_statutory && !e.has_filing,
      needsReason: reopen,
      reopen,
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Hints (§6.3, §6.7)
// -------------------------------------------------------------------------------------------------

export type HintTone = "danger" | "warning" | "info" | "neutral";
export interface EventHint {
  kind: "sunday" | "gstr1a" | "ims" | "filing_bar" | "barred" | "late_fee" | "provisional" | "extended";
  tone: HintTone;
  text: string;
}

/** §6.7: from the July 2025 tax period the GSTR-3B liability from GSTR-1/1A/IFF is locked [verify]. */
export const GSTR3B_LOCK_FROM: DateString = "2025-07-01";

/** The GSTR-3B checklist line the spec prescribes (§6.7), word for word. */
export const GSTR3B_CHECKLIST_ITEM = "Review auto-populated liability; correct through GSTR-1A before filing 3B";
export const IMS_CHECKLIST_ITEM = "Act on inward invoices in IMS first: pending ones count as accepted, and GSTR-2B is regenerated after IMS actions";

/** The task checklist items a deadline brings with it (§6.7 portal behaviour notes). */
export function checklistHints(e: { form_code: string | null; period_start: DateString | null }): string[] {
  if ((e.form_code ?? "").toUpperCase() !== "GSTR-3B") return [];
  const locked = !e.period_start || compareDates(e.period_start, GSTR3B_LOCK_FROM) >= 0;
  return locked ? [GSTR3B_CHECKLIST_ITEM, IMS_CHECKLIST_ITEM] : [IMS_CHECKLIST_ITEM];
}

export interface HintContext {
  today: DateString;
  /** Rule codes whose returns carry the GST three-year bar (rule.filingBar, §6.7). */
  filingBarRules: ReadonlySet<string>;
  filingBar: Pick<FilingBarParams, "years" | "warnMonths" | "fromPeriod">;
  /** Rule codes with an ROC late fee per day (rule.lateFee, §6.7). */
  lateFeeRules: ReadonlySet<string>;
  lateFeePerDayPaise: Paise;
}

export interface HintEvent extends StatusLike {
  form_code: string | null;
  rule_code: string | null;
  period_start: DateString | null;
  period_end: DateString | null;
  is_provisional?: boolean | null;
  original_due_date?: DateString | null;
  override_ref?: string | null;
}

export function eventHints(e: HintEvent, ctx: HintContext): EventHint[] {
  const out: EventHint[] = [];
  const done = isDone(e) || e.status === "cancelled";
  const ruleCode = e.rule_code ?? "";

  if (!done && ctx.filingBarRules.has(ruleCode) && (!e.period_end || compareDates(e.period_end, ctx.filingBar.fromPeriod) >= 0)) {
    const bar = filingBarStatus(e.original_due_date ?? e.due_date, ctx.today, { params: ctx.filingBar });
    if (bar.barred) {
      out.push({ kind: "barred", tone: "danger", text: `The ${ctx.filingBar.years}-year limit passed on ${formatDate(bar.barDate)}: this return can no longer be filed.` });
    } else if (bar.nearBar) {
      out.push({ kind: "filing_bar", tone: "danger", text: `Can't be filed after ${formatDate(bar.barDate)} (${ctx.filingBar.years} years from the due date). File it now.` });
    }
  }

  if (!done && ctx.lateFeeRules.has(ruleCode) && compareDates(e.due_date, ctx.today) < 0) {
    const fee = lateFeeAccrued(e.due_date, ctx.today, ctx.lateFeePerDayPaise);
    out.push({
      kind: "late_fee",
      tone: "warning",
      text: `Late fee accruing: ${formatINR(ctx.lateFeePerDayPaise)} a day per form, ${formatINR(fee.amountPaise)} so far (${fee.daysLate} ${fee.daysLate === 1 ? "day" : "days"}).`,
    });
  }

  if (e.override_ref && e.original_due_date) {
    out.push({ kind: "extended", tone: "info", text: `Extended from ${formatDate(e.original_due_date)} by ${e.override_ref}.` });
  }

  if (e.is_provisional && !done) {
    out.push({ kind: "provisional", tone: "neutral", text: "Provisional date: it moves once the actual date it depends on (the AGM, for ROC forms) is entered." });
  }

  const sunday = sundayHint(e.due_date);
  if (sunday && !done) out.push({ kind: "sunday", tone: "neutral", text: `${sunday}. Statutory due dates aren't moved off a Sunday.` });

  if (!done) {
    for (const line of checklistHints(e)) {
      out.push({ kind: line === GSTR3B_CHECKLIST_ITEM ? "gstr1a" : "ims", tone: "info", text: `${line}.` });
    }
  }
  return out;
}

/** The first URL in a circular reference, if it carries one (the extension badge links to it). */
export function circularUrl(sourceRef: string | null | undefined): string | null {
  const m = sourceRef ? /https?:\/\/[^\s)]+/i.exec(sourceRef) : null;
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

// -------------------------------------------------------------------------------------------------
// The client compliance report (§7.7, §11)
// -------------------------------------------------------------------------------------------------

export type ReportOutcome = "on_time" | "late" | "filed" | "overdue" | "due";

export const REPORT_OUTCOME_LABEL: Readonly<Record<ReportOutcome, string>> = {
  on_time: "On time",
  late: "Late",
  filed: "Filed",
  overdue: "Not filed",
  due: "Not yet due",
};

/**
 * Whether a deadline was met (§7.7 "whether it was on time"): filed on or before the due date in
 * force (an extended date counts), late by N days, filed with no date recorded, overdue, or not
 * yet due.
 */
export function reportOutcome(
  e: Pick<StatusLike, "status" | "workflow_status" | "due_date">,
  filedOn: DateString | null,
  today: DateString,
): { outcome: ReportOutcome; days: number; text: string } {
  if (isDone(e)) {
    if (!filedOn || !isDateString(filedOn)) return { outcome: "filed", days: 0, text: "Filed (date not recorded)" };
    const late = diffDays(filedOn, e.due_date);
    if (late <= 0) return { outcome: "on_time", days: 0, text: "On time" };
    return { outcome: "late", days: late, text: `Late by ${late} ${late === 1 ? "day" : "days"}` };
  }
  const overdue = diffDays(today, e.due_date);
  if (overdue > 0) return { outcome: "overdue", days: overdue, text: `Not filed, ${overdue} ${overdue === 1 ? "day" : "days"} overdue` };
  return { outcome: "due", days: -overdue, text: overdue === 0 ? "Due today" : "Not yet due" };
}
