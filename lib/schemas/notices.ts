import { z } from "zod";
import { NOTICE_STATUSES, type NoticeStatus } from "@/lib/domain/enums";
import { addDays, compareDates, diffDays, isDateString, isFinancialYear, taxYearLabel, type DateString } from "@/lib/domain/fy";
import { APPEAL_DEFAULTS, APPEAL_FORUM_LABELS, appealLimitationDate, type AppealForum, type LimitationPeriod } from "@/lib/domain/escalation";
import { paiseToDecimalString, parseAmount } from "@/lib/domain/money";

/**
 * The notices and litigation register (§7.8.4): the form values and the actions' inputs (one zod
 * schema shared by both, CONVENTIONS §5), the notice-type presets, the workflow's allowed moves and
 * what each needs, the appeal forums and their limitation preview (lib/domain/escalation.ts, the
 * same periods the database reads from statutory_parameters), the register's filters and sorts,
 * and the reminder plan the daily job follows (7 and 2 days before the reply due date, the hearing
 * and the limitation date; overdue replies flagged). Client-safe; no I/O.
 */

// =================================================================================================
// Vocabulary
// =================================================================================================

export const TAX_AREAS = ["gst", "income_tax", "tds", "other"] as const;
export type TaxArea = (typeof TAX_AREAS)[number];

export const TAX_AREA_LABEL: Record<TaxArea, string> = { gst: "GST", income_tax: "Income tax", tds: "TDS", other: "Other" };

/** The notice types offered in the select (§7.8.4 "select + free text"); "Other" lets the person type one. */
export const NOTICE_TYPE_PRESETS: ReadonlyArray<{ value: string; area: TaxArea; section: string | null; hint: string }> = [
  { value: "GST DRC-01", area: "gst", section: "73/74", hint: "Show cause notice summary (demand)" },
  { value: "GST DRC-01A", area: "gst", section: "73/74", hint: "Intimation before a show cause notice" },
  { value: "GST ASMT-10", area: "gst", section: "61", hint: "Scrutiny of returns: discrepancies" },
  { value: "GST REG-17", area: "gst", section: "29", hint: "Show cause notice for cancellation" },
  { value: "GST REG-03", area: "gst", section: null, hint: "Clarification on a registration application" },
  { value: "IT 143(1)", area: "income_tax", section: "143(1)", hint: "Intimation after processing the return" },
  { value: "IT 143(2)", area: "income_tax", section: "143(2)", hint: "Scrutiny assessment" },
  { value: "IT 142(1)", area: "income_tax", section: "142(1)", hint: "Inquiry before assessment" },
  { value: "IT 148A", area: "income_tax", section: "148A", hint: "Before reopening an assessment" },
  { value: "IT 148", area: "income_tax", section: "148", hint: "Reassessment" },
  { value: "IT 139(9)", area: "income_tax", section: "139(9)", hint: "Defective return" },
  { value: "TDS 200A", area: "tds", section: "200A", hint: "Intimation after processing a TDS statement" },
  { value: "TDS 201", area: "tds", section: "201", hint: "Assessee in default" },
];

export const OTHER_TYPE = "__other__";

export function presetFor(type: string): (typeof NOTICE_TYPE_PRESETS)[number] | null {
  return NOTICE_TYPE_PRESETS.find((p) => p.value === type) ?? null;
}

export const APPEAL_FORUMS = ["income_tax_first_appeal", "income_tax_tribunal", "gst_first_appeal", "gst_tribunal", "other"] as const;
export type NoticeAppealForum = (typeof APPEAL_FORUMS)[number];

export const APPEAL_FORUM_LABEL: Record<NoticeAppealForum, string> = { ...APPEAL_FORUM_LABELS, other: "Another forum (enter the limitation date)" };

/** The forums offered for a notice's area: income-tax forums for income tax and TDS, GST forums for GST. */
export function appealForumsFor(area: TaxArea | null | undefined): NoticeAppealForum[] {
  if (area === "gst") return ["gst_first_appeal", "gst_tribunal", "other"];
  if (area === "income_tax" || area === "tds") return ["income_tax_first_appeal", "income_tax_tribunal", "other"];
  return [...APPEAL_FORUMS];
}

/** The last day to appeal, as the database will compute it (null for "other": entered by hand). */
export function limitationPreview(
  forum: NoticeAppealForum | null | undefined,
  orderDate: string | null | undefined,
  appeals: Record<AppealForum, LimitationPeriod> = APPEAL_DEFAULTS,
): DateString | null {
  if (!forum || forum === "other" || !orderDate || !isDateString(orderDate)) return null;
  return appealLimitationDate(forum, orderDate, appeals);
}

export function limitationPeriodText(p: LimitationPeriod): string {
  return "days" in p ? `${p.days} days` : `${p.months} ${p.months === 1 ? "month" : "months"}`;
}

export const CLOSED_STATUSES = ["closed_favourable", "closed_unfavourable", "closed_partial"] as const satisfies readonly NoticeStatus[];
export const OPEN_STATUSES = ["open", "reply_drafted", "replied", "hearing"] as const satisfies readonly NoticeStatus[];

export function isClosed(s: NoticeStatus): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(s);
}

/** Closing against the client (in whole or part) asks whether to appeal (§7.8.4). */
export function needsAppealDecision(s: NoticeStatus): boolean {
  return s === "closed_unfavourable" || s === "closed_partial";
}

/**
 * Where a notice can go next (§3.6 "Open → Reply drafted → Replied → Hearing → Closed"): any open
 * step to another, or closed with an outcome; a closed notice is reopened (to Open or Hearing) by a
 * Partner or Manager only, and an unfavourable or partial one can have its appeal details updated.
 */
export function noticeMoves(from: NoticeStatus, role: "partner" | "manager" | "employee"): NoticeStatus[] {
  const mp = role !== "employee";
  if (isClosed(from)) {
    const reopen: NoticeStatus[] = mp ? ["open", "hearing"] : [];
    return needsAppealDecision(from) ? [...reopen, from] : reopen;
  }
  return NOTICE_STATUSES.filter((s) => s !== from);
}

/** The usual next step, for the primary button. */
export function nextNoticeStep(from: NoticeStatus): NoticeStatus | null {
  switch (from) {
    case "open":
      return "reply_drafted";
    case "reply_drafted":
      return "replied";
    case "replied":
    case "hearing":
      return "closed_favourable";
    default:
      return null;
  }
}

// =================================================================================================
// Hearing date and time (stored as timestamptz; entered and shown in IST)
// =================================================================================================

/** "2026-10-30" + "11:30" → "2026-10-30T11:30:00+05:30"; null when no date. A date without a time is 10:30. */
export function hearingIso(date: string | null | undefined, time: string | null | undefined): string | null {
  if (!date || !isDateString(date)) return null;
  const t = time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "10:30";
  return `${date}T${t}:00+05:30`;
}

/** The IST date and time of a stored hearing. */
export function splitHearing(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const ist = new Date(d.getTime() + 330 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`,
    time: `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`,
  };
}

/** "AY 2024-25" / "Tax year 2026-27" for the year a notice is about (§6.1), or null. */
export function noticeYearLabel(fy: string | null | undefined): string | null {
  return fy && isFinancialYear(fy) ? taxYearLabel(fy) : null;
}

// =================================================================================================
// Form values
// =================================================================================================

const optionalUuid = z
  .union([z.uuid(), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${label} under ${max.toLocaleString("en-IN")} characters.` })
    .optional()
    .default("");
const optionalDate = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((v) => v === "" || isDateString(v), { error: `Enter the ${label}, for example 22 Oct 2026.` });
const timeText = z
  .string()
  .trim()
  .optional()
  .default("")
  .refine((v) => v === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), { error: "Enter the time as HH:MM, for example 11:30." });

export const NoticeFormSchema = z
  .object({
    id: optionalUuid,
    updated_at: z.string().nullish().transform((v) => (v ? v : null)),
    client_id: z.string().trim().refine((v) => z.uuid().safeParse(v).success, { error: "Choose the client." }),
    type_choice: z.string().trim().optional().default(""),
    notice_type: z
      .string()
      .trim()
      .min(1, { error: "Choose or type the notice type." })
      .max(120, { error: "Keep the notice type under 120 characters." }),
    tax_area: z.union([z.enum(TAX_AREAS), z.literal("")]).optional().default(""),
    section: text(80, "section"),
    authority: text(200, "authority"),
    reference_no: text(100, "reference"),
    financial_year: z
      .string()
      .trim()
      .optional()
      .default("")
      .refine((v) => v === "" || isFinancialYear(v), { error: "Enter the year as YYYY-YY, for example 2024-25." }),
    notice_date: optionalDate("notice date"),
    received_date: optionalDate("received date"),
    reply_due_date: z
      .string()
      .trim()
      .refine((v) => isDateString(v), { error: "Enter the reply due date." }),
    hearing_date: optionalDate("hearing date"),
    hearing_time: timeText,
    demand_amount: z
      .union([z.string(), z.number()])
      .optional()
      .default("")
      .transform((v) => String(v ?? "").trim())
      .refine((v) => v === "" || parseAmount(v).ok, { error: "Enter the demand in rupees, for example 1,25,000." }),
    description: text(5000, "description"),
    assigned_employee_id: optionalUuid,
    replied_on: optionalDate("reply date"),
    status: z.enum(OPEN_STATUSES).optional().default("open"),
  })
  .superRefine((v, ctx) => {
    if (v.notice_date && v.received_date && compareDates(v.received_date, v.notice_date) < 0) {
      ctx.addIssue({ code: "custom", path: ["received_date"], message: "The notice can't be received before its date." });
    }
    if (v.notice_date && v.reply_due_date && isDateString(v.reply_due_date) && compareDates(v.reply_due_date, v.notice_date) < 0) {
      ctx.addIssue({ code: "custom", path: ["reply_due_date"], message: "The reply due date can't be before the notice date." });
    }
    if (v.hearing_time && !v.hearing_date) ctx.addIssue({ code: "custom", path: ["hearing_date"], message: "Enter the hearing date for that time." });
    if (v.status === "hearing" && !v.hearing_date) ctx.addIssue({ code: "custom", path: ["hearing_date"], message: "Enter the hearing date and time." });
  });
export type NoticeFormInput = z.input<typeof NoticeFormSchema>;
export type NoticeFormValues = z.output<typeof NoticeFormSchema>;

/** The payload for save_tax_notice (0206). */
export function noticePayload(v: NoticeFormValues, opts: { creating: boolean }): Record<string, unknown> {
  const demand = v.demand_amount ? parseAmount(v.demand_amount) : null;
  return {
    id: v.id,
    updated_at: v.updated_at,
    client_id: v.client_id,
    notice_type: v.notice_type,
    tax_area: v.tax_area || null,
    section: v.section || null,
    authority: v.authority || null,
    reference_no: v.reference_no || null,
    financial_year: v.financial_year || null,
    notice_date: v.notice_date || null,
    received_date: v.received_date || null,
    reply_due_date: v.reply_due_date,
    hearing_date: hearingIso(v.hearing_date, v.hearing_time),
    demand_amount: demand && demand.ok ? paiseToDecimalString(demand.paise) : null,
    description: v.description || null,
    assigned_employee_id: v.assigned_employee_id,
    replied_on: v.replied_on || null,
    ...(opts.creating ? { status: v.status } : {}),
  };
}

export const NoticeStatusSchema = z
  .object({
    id: z.uuid(),
    updatedAt: z.string().min(1, { error: "Reload the notice and try again." }),
    status: z.enum(NOTICE_STATUSES),
    note: text(2000, "note"),
    replied_on: optionalDate("reply date"),
    hearing_date: optionalDate("hearing date"),
    hearing_time: timeText,
    order_date: optionalDate("order date"),
    appeal_decision: z.union([z.enum(["appeal", "no_appeal"]), z.literal("")]).optional().default(""),
    appeal_forum: z.union([z.enum(APPEAL_FORUMS), z.literal("")]).optional().default(""),
    limitation_date: optionalDate("limitation date"),
    appeal_note: text(1000, "reason"),
    /** The status the notice had when the dialog opened (reopening needs a reason). */
    from_status: z.enum(NOTICE_STATUSES).optional(),
  })
  .superRefine((v, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.status === "hearing" && !v.hearing_date && v.from_status !== "hearing") add("hearing_date", "Enter the hearing date and time.");
    if (needsAppealDecision(v.status)) {
      if (!v.order_date) add("order_date", "Enter the date of the order.");
      if (!v.appeal_decision) add("appeal_decision", "Record whether the client will appeal.");
      if (v.appeal_decision === "appeal" && !v.appeal_forum) add("appeal_forum", "Choose the appeal forum.");
      if (v.appeal_decision === "appeal" && v.appeal_forum === "other" && !v.limitation_date) add("limitation_date", "Enter the limitation date for this forum.");
      if (v.appeal_decision === "no_appeal" && !v.appeal_note) add("appeal_note", "Say why the client won't appeal.");
      if (v.order_date && v.limitation_date && compareDates(v.limitation_date, v.order_date) < 0) add("limitation_date", "The limitation date can't be before the order date.");
    }
    if (v.from_status && isClosed(v.from_status) && !isClosed(v.status) && !v.note) add("note", "Say why the notice is reopened.");
  });
export type NoticeStatusInput = z.input<typeof NoticeStatusSchema>;
export type NoticeStatusValues = z.output<typeof NoticeStatusSchema>;

/** The payload for set_tax_notice_status (0206). */
export function statusPayload(v: NoticeStatusValues): Record<string, unknown> {
  const appeal = needsAppealDecision(v.status)
    ? {
        decision: v.appeal_decision || null,
        forum: v.appeal_decision === "appeal" ? v.appeal_forum || null : null,
        limitation_date: v.appeal_decision === "appeal" ? v.limitation_date || null : null,
        note: v.appeal_note || null,
      }
    : null;
  return {
    note: v.note || null,
    replied_on: v.status === "replied" ? v.replied_on || null : null,
    hearing_date: v.hearing_date ? hearingIso(v.hearing_date, v.hearing_time) : null,
    order_date: isClosed(v.status) ? v.order_date || null : null,
    ...(appeal ? { appeal } : {}),
  };
}

export const NoticeNoteSchema = z.object({
  notice_id: z.uuid(),
  noted_on: z
    .string()
    .trim()
    .refine((v) => isDateString(v), { error: "Enter the date of the note." }),
  body: z
    .string()
    .trim()
    .min(1, { error: "Write the note." })
    .max(4000, { error: "Keep the note under 4,000 characters." }),
});
export type NoticeNoteInput = z.input<typeof NoticeNoteSchema>;

export const NOTICE_DOCUMENT_KINDS = ["notice", "reply", "order", "appeal", "other"] as const;
export type NoticeDocumentKind = (typeof NOTICE_DOCUMENT_KINDS)[number];
export const NOTICE_DOCUMENT_KIND_LABEL: Record<NoticeDocumentKind, string> = { notice: "Notice", reply: "Reply", order: "Order", appeal: "Appeal", other: "Other" };

export const AttachNoticeDocumentsSchema = z.object({
  notice_id: z.uuid(),
  document_ids: z.array(z.uuid()).min(1).max(20),
  kind: z.enum(NOTICE_DOCUMENT_KINDS),
});
export const DetachNoticeDocumentSchema = z.object({ id: z.uuid() });
export const NoticeRefSchema = z.object({ id: z.uuid() });
export const NoticeClientSearchSchema = z.object({ q: z.string().trim().max(100).optional().default("") });

// =================================================================================================
// The register's filters and sorts (§2.3)
// =================================================================================================

export const NOTICE_ATTENTION = ["reply_overdue", "reply_week", "hearing_week", "appeal_open"] as const;
export type NoticeAttention = (typeof NOTICE_ATTENTION)[number];
export const NOTICE_ATTENTION_LABEL: Record<NoticeAttention, string> = {
  reply_overdue: "Reply overdue",
  reply_week: "Reply due in 7 days",
  hearing_week: "Hearing in 7 days",
  appeal_open: "Appeal to file",
};

/** "open" and "closed" stand for every open or closed status. */
export const NOTICE_STATUS_FILTER = [...NOTICE_STATUSES, "all_open", "all_closed"] as const;

export const NOTICE_LIST_SORTABLE = ["next_action_date", "reply_due_date", "hearing_date", "notice_date", "client_name", "demand_amount", "updated_at"] as const;
export type NoticeListSort = (typeof NOTICE_LIST_SORTABLE)[number];

export const NOTICE_LIST_FILTERS = {
  status: NOTICE_STATUS_FILTER,
  area: TAX_AREAS,
  attention: NOTICE_ATTENTION,
  assigned: null,
  client: null,
} as const;
export type NoticeListFilter = keyof typeof NOTICE_LIST_FILTERS;

// =================================================================================================
// Urgency and reminders (§7.8.4, §8 "notice reply and hearing reminders")
// =================================================================================================

export type NoticeDates = {
  status: NoticeStatus;
  replyDueDate: DateString | null;
  /** The hearing's date in IST. */
  hearingOn: DateString | null;
  appealDecision: "appeal" | "no_appeal" | null;
  limitationDate: DateString | null;
  /** The appeal task is filed (the appeal went in). */
  appealFiled: boolean;
};

export type NextAction = { kind: "reply" | "hearing" | "appeal"; date: DateString; daysLeft: number; overdue: boolean };

/** The date someone has to act on next, and how far away it is. */
export function nextNoticeAction(n: NoticeDates, today: DateString): NextAction | null {
  const options: NextAction[] = [];
  if ((n.status === "open" || n.status === "reply_drafted") && n.replyDueDate) {
    const d = diffDays(n.replyDueDate, today);
    options.push({ kind: "reply", date: n.replyDueDate, daysLeft: d, overdue: d < 0 });
  }
  if (!isClosed(n.status) && n.hearingOn && compareDates(n.hearingOn, today) >= 0) {
    options.push({ kind: "hearing", date: n.hearingOn, daysLeft: diffDays(n.hearingOn, today), overdue: false });
  }
  if (n.appealDecision === "appeal" && n.limitationDate && !n.appealFiled) {
    const d = diffDays(n.limitationDate, today);
    options.push({ kind: "appeal", date: n.limitationDate, daysLeft: d, overdue: d < 0 });
  }
  if (!options.length) return null;
  options.sort((a, b) => compareDates(a.date, b.date));
  return options[0];
}

export const REMINDER_LEAD_DAYS = [7, 2] as const;

export type NoticeReminder = {
  kind: "reply" | "hearing" | "appeal" | "reply_overdue" | "appeal_overdue";
  /** 7 or 2 days before; 0 for an overdue flag. */
  lead: number;
  date: DateString;
  daysLeft: number;
  /** Notifies once per notice, date and lead, however often the job runs. */
  dedupeKey: string;
};

/**
 * The reminders the 09:00 job sends today for one notice (§7.8.4 "Reminders at 7 and 2 days before
 * the reply due date and the hearing", appeal limitation the same way; an overdue reply is flagged
 * once). A reminder is due from its lead day onwards, so a day the job missed is caught up the next
 * day; the dedupe key (notice, date, lead) makes each one go once, and a moved date starts afresh.
 * The 2-day reminder replaces the 7-day one when both are due (only the nearer is sent).
 */
export function planNoticeReminders(id: string, n: NoticeDates, today: DateString): NoticeReminder[] {
  const out: NoticeReminder[] = [];
  const windowed = (kind: "reply" | "hearing" | "appeal", date: DateString) => {
    const daysLeft = diffDays(date, today);
    if (daysLeft < 0) return;
    const lead = [...REMINDER_LEAD_DAYS].sort((a, b) => a - b).find((l) => daysLeft <= l);
    if (lead === undefined) return;
    out.push({ kind, lead, date, daysLeft, dedupeKey: `notice_${kind}:${id}:${date}:${lead}` });
  };
  const replyPending = n.status === "open" || n.status === "reply_drafted";
  if (replyPending && n.replyDueDate) {
    if (compareDates(n.replyDueDate, today) < 0) {
      out.push({ kind: "reply_overdue", lead: 0, date: n.replyDueDate, daysLeft: diffDays(n.replyDueDate, today), dedupeKey: `notice_reply_overdue:${id}:${n.replyDueDate}` });
    } else windowed("reply", n.replyDueDate);
  }
  if (!isClosed(n.status) && n.hearingOn) windowed("hearing", n.hearingOn);
  if (n.appealDecision === "appeal" && n.limitationDate && !n.appealFiled) {
    if (compareDates(n.limitationDate, today) < 0) {
      out.push({ kind: "appeal_overdue", lead: 0, date: n.limitationDate, daysLeft: diffDays(n.limitationDate, today), dedupeKey: `notice_appeal_overdue:${id}:${n.limitationDate}` });
    } else windowed("appeal", n.limitationDate);
  }
  return out;
}

/** The first day any reminder of a date can fall (for the job's query window). */
export function reminderQueryStart(today: DateString): DateString {
  return addDays(today, -1);
}
export function reminderQueryEnd(today: DateString): DateString {
  return addDays(today, Math.max(...REMINDER_LEAD_DAYS));
}
