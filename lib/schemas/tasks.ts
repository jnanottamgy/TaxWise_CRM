/**
 * The work tracker's inputs and the small pure rules around them (§7.6): the task form, status
 * moves, acceptance, filing capture, bulk changes, comments and mentions, checklist, dependencies,
 * attachments, saved views and the list's filters. Shared by the forms (client) and
 * server/actions/{tasks,task-comments,task-checklist,task-dependencies}.ts. Client-safe.
 *
 * The status rules themselves are lib/domain/transitions.ts (and change_task_status in the
 * database); the assignment check is lib/domain/assignment.ts.
 */

import { z } from "zod";
import {
  DECLINE_REASONS,
  DECLINE_REASON_LABELS,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  TASK_ACCEPTANCES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ServiceType,
  type TaskStatus,
} from "@/lib/domain/enums";
import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  financialYearOf,
  fyStart,
  isDateString,
  isFinancialYear,
  isoWeekday,
  MONTH_ABBR,
  parseDateString,
  parsePeriodLabel,
  toDateString,
  type DateString,
} from "@/lib/domain/fy";

// =================================================================================================
// Vocabulary
// =================================================================================================

/** Every status but Filed/Done: the work still to do. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter((s) => s !== "filed_done");

/**
 * Services whose work ends in a filing (§7.6.5: "a task with a filing service"): returns, statements,
 * forms and reports filed with a department. Bookkeeping and "Other" aren't, unless the task is
 * linked to a compliance deadline.
 */
export const FILING_SERVICES: readonly ServiceType[] = ["gst", "income_tax", "tds", "payroll", "audit", "company_law", "incorporation"];

/** True when moving the task to Filed/Done asks for the filing details (§7.6.5). */
export function needsFilingCapture(task: { service_type: ServiceType | null; compliance_event_id: string | null }): boolean {
  return task.compliance_event_id !== null || (task.service_type !== null && FILING_SERVICES.includes(task.service_type));
}

export const SERVICE_OPTIONS = SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] }));
export const DECLINE_REASON_OPTIONS = DECLINE_REASONS.map((r) => ({ value: r, label: DECLINE_REASON_LABELS[r] }));

// =================================================================================================
// Shared field helpers
// =================================================================================================

const idField = z.uuid({ error: "Reload the page and try again." });
const optionalId = (error: string) =>
  z
    .union([z.uuid({ error }), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));
const optionalDate = (error: string) =>
  z
    .union([z.string().trim(), z.null()])
    .optional()
    .refine((v) => !v || isDateString(v), { error })
    .transform((v) => (v ? v : null));
const expectedUpdatedAt = z.string().min(1, { error: "Reload the page and try again." });

/** Hours and minutes typed into the form (either may be blank) → total minutes, or null when both are blank. */
export function estimateMinutes(hours: string | number | null | undefined, minutes: string | number | null | undefined): number | null {
  const h = hours === null || hours === undefined || hours === "" ? null : Number(hours);
  const m = minutes === null || minutes === undefined || minutes === "" ? null : Number(minutes);
  if (h === null && m === null) return null;
  return Math.round((h ?? 0) * 60) + Math.round(m ?? 0);
}

/** Total minutes → the form's hours and minutes ("" for a missing estimate). */
export function splitEstimate(total: number | null | undefined): { hours: string; minutes: string } {
  if (total === null || total === undefined) return { hours: "", minutes: "" };
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

const hoursField = z
  .union([z.string().trim(), z.number()])
  .optional()
  .refine((v) => v === undefined || v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000), {
    error: "Enter hours between 0 and 1,000.",
  });
const minutesField = z
  .union([z.string().trim(), z.number()])
  .optional()
  .refine((v) => v === undefined || v === "" || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < 60), {
    error: "Enter minutes between 0 and 59.",
  });

// =================================================================================================
// Task form (§7.6.2)
// =================================================================================================

export const TASK_LIMITS = { title: 300, description: 5000, remarks: 2000, period: 40, checklistItem: 300, checklistItems: 50, blockers: 20 } as const;

const TaskFieldsSchema = z.object({
  client_id: z.uuid({ error: "Choose the client." }),
  title: z.string().trim().min(1, { error: "Give the task a title." }).max(TASK_LIMITS.title, { error: `Keep the title under ${TASK_LIMITS.title} characters.` }),
  description: optionalText(TASK_LIMITS.description),
  service_type: z
    .union([z.enum(SERVICE_TYPES), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  financial_year: z
    .union([z.string().trim(), z.null()])
    .optional()
    .refine((v) => !v || isFinancialYear(v), { error: "Enter the financial year as YYYY-YY, for example 2026-27." })
    .transform((v) => (v ? v : null)),
  period_label: optionalText(TASK_LIMITS.period),
  due_date: optionalDate("Enter the due date as a date."),
  priority: z.enum(TASK_PRIORITIES).default("medium"),
  estimate_hours: hoursField,
  estimate_minutes: minutesField,
  assigned_employee_id: optionalId("Choose who does it."),
  reviewer_employee_id: optionalId("Choose the reviewer."),
  remarks: optionalText(TASK_LIMITS.remarks),
  compliance_event_id: optionalId("Choose the deadline again."),
});

function reviewerNotAssignee(v: { assigned_employee_id: string | null; reviewer_employee_id: string | null }) {
  return !v.assigned_employee_id || !v.reviewer_employee_id || v.assigned_employee_id !== v.reviewer_employee_id;
}
const REVIEWER_IS_ASSIGNEE = "The reviewer can't also be the assignee: nobody reviews their own work.";

export const CreateTaskSchema = TaskFieldsSchema.extend({
  template_id: optionalId("Choose the template again."),
  checklist: z
    .array(z.object({ title: z.string().trim().max(TASK_LIMITS.checklistItem, { error: `Keep each item under ${TASK_LIMITS.checklistItem} characters.` }) }))
    .max(TASK_LIMITS.checklistItems, { error: `Add at most ${TASK_LIMITS.checklistItems} items here; add more from the task.` })
    .default([]),
  blocker_ids: z.array(idField).max(TASK_LIMITS.blockers, { error: `Pick at most ${TASK_LIMITS.blockers} blocking tasks.` }).default([]),
}).refine(reviewerNotAssignee, { error: REVIEWER_IS_ASSIGNEE, path: ["reviewer_employee_id"] });
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;
export type CreateTaskOutput = z.output<typeof CreateTaskSchema>;

export const UpdateTaskSchema = TaskFieldsSchema.extend({
  id: idField,
  expected_updated_at: expectedUpdatedAt,
}).refine(reviewerNotAssignee, { error: REVIEWER_IS_ASSIGNEE, path: ["reviewer_employee_id"] });
export type UpdateTaskInput = z.input<typeof UpdateTaskSchema>;
export type UpdateTaskOutput = z.output<typeof UpdateTaskSchema>;

/** What an Employee may change on their own task (§4.6): the remarks. */
export const UpdateRemarksSchema = z.object({ id: idField, remarks: optionalText(TASK_LIMITS.remarks), expected_updated_at: expectedUpdatedAt });

export const DeleteTaskSchema = z.object({ id: idField, expected_updated_at: expectedUpdatedAt });

/** Asked while the form is open: the assignment check (§7.6.2), before saving. */
export const AssignmentCheckSchema = z.object({
  task_id: optionalId("Reload the page and try again."),
  client_id: optionalId("Choose the client."),
  assigned_employee_id: optionalId("Choose who does it."),
  reviewer_employee_id: optionalId("Choose the reviewer."),
  due_date: optionalDate("Enter the due date as a date."),
});

// =================================================================================================
// Status, acceptance, filing (§7.6.3–§7.6.5)
// =================================================================================================

export const ChangeStatusSchema = z.object({
  id: idField,
  to: z.enum(TASK_STATUSES, { error: "Choose the status to move it to." }),
  reason: optionalText(500),
});
export type ChangeStatusInput = z.input<typeof ChangeStatusSchema>;

export const RespondSchema = z
  .object({
    id: idField,
    accept: z.boolean(),
    reason: z
      .union([z.enum(DECLINE_REASONS), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    note: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.accept) return;
    if (!v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Choose a reason for declining." });
    else if (v.reason === "other" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Add a note saying why you're declining." });
  });
export type RespondInput = z.input<typeof RespondSchema>;

export const FILING_MODES = ["record", "existing", "skip"] as const;

export const FileTaskSchema = z
  .object({
    id: idField,
    expected_updated_at: z.string().nullish(),
    mode: z.enum(FILING_MODES),
    filing_type: optionalText(60),
    period: optionalText(40),
    financial_year: z.string().trim().nullish(),
    filed_on: z.string().trim().nullish(),
    acknowledgement_no: optionalText(60),
    document_id: optionalId("Upload the acknowledgement again."),
    udin_record_id: optionalId("Choose the UDIN again."),
    shareable_with_client: z.boolean().default(false),
    notes: optionalText(2000),
    filing_record_id: optionalId("Choose the filing again."),
    skip_reason: optionalText(500),
  })
  .superRefine((v, ctx) => {
    const need = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (v.mode === "skip") {
      if (!v.skip_reason) need("skip_reason", "Say why there's nothing to file.");
      return;
    }
    if (v.mode === "existing") {
      if (!v.filing_record_id) need("filing_record_id", "Choose the filing already recorded.");
      return;
    }
    if (!v.filing_type) need("filing_type", "Enter the return or form that was filed.");
    if (!v.period) need("period", "Enter the period the return is for.");
    if (!v.financial_year || !isFinancialYear(v.financial_year)) need("financial_year", "Enter the financial year as YYYY-YY, for example 2026-27.");
    if (!v.filed_on || !isDateString(v.filed_on)) need("filed_on", "Enter the date it was filed.");
  });
export type FileTaskInput = z.input<typeof FileTaskSchema>;

/** The filing dialog's starting values (§7.6.5 "Return / form (from the compliance event)"). */
export function filingDefaults(
  task: { title: string; period_label: string | null; financial_year: string | null },
  event: { form_code: string | null; filing_period: string | null; financial_year: string | null; title: string } | null,
  today: DateString,
): { filing_type: string; period: string; financial_year: string; filed_on: DateString } {
  const period = event?.filing_period ?? task.period_label ?? "";
  const fromPeriod = period ? parsePeriodLabel(period)?.financialYear ?? null : null;
  return {
    filing_type: event?.form_code ?? guessFormCode(event?.title ?? task.title) ?? "",
    period,
    financial_year: event?.financial_year ?? task.financial_year ?? fromPeriod ?? financialYearOf(today),
    filed_on: today,
  };
}

const FORM_CODE = /\b(GSTR[-\s]?(?:1A|1|2B|3B|4|5|6|7|8|9C|9|10)|ITR[-\s]?(?:[1-7]|U)|2[4-7]E?Q|AOC[-\s]?4|MGT[-\s]?7A?|DIR[-\s]?3|ADT[-\s]?1|3CD|3CA|3CB|CMP[-\s]?08|PMT[-\s]?06)\b/i;

/** The form code a title names ("GSTR3B: Sep 2026" → "GSTR-3B", "ITR 4" → "ITR-4"); null when none. */
export function guessFormCode(title: string | null | undefined): string | null {
  const m = FORM_CODE.exec(title ?? "");
  if (!m) return null;
  const raw = m[1].toUpperCase();
  return raw.replace(/^(GSTR|ITR|AOC|MGT|DIR|ADT|CMP|PMT)[-\s]?/, "$1-");
}

// =================================================================================================
// Bulk (§7.6.7)
// =================================================================================================

export const BULK_MAX = 500;

export const BulkTaskSchema = z
  .object({
    ids: z.array(idField).min(1, { error: "Select at least one task." }).max(BULK_MAX, { error: `Change at most ${BULK_MAX} tasks at a time.` }),
    change: z.enum(["assignee", "reviewer", "due_date", "priority"]),
    assigned_employee_id: optionalId("Choose who to assign them to."),
    reviewer_employee_id: optionalId("Choose the reviewer."),
    due_date: optionalDate("Enter the new due date."),
    priority: z
      .union([z.enum(TASK_PRIORITIES), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    reason: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.change === "due_date" && !v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Give a reason for changing the due date." });
    if (v.change === "priority" && !v.priority) ctx.addIssue({ code: "custom", path: ["priority"], message: "Choose the priority." });
  });
export type BulkTaskInput = z.input<typeof BulkTaskSchema>;

/** The `p_changes` object bulk_update_tasks takes for one kind of change. */
export function bulkChanges(v: z.output<typeof BulkTaskSchema>): Record<string, string | null> {
  switch (v.change) {
    case "assignee":
      return { assigned_employee_id: v.assigned_employee_id };
    case "reviewer":
      return { reviewer_employee_id: v.reviewer_employee_id };
    case "due_date":
      return { due_date: v.due_date };
    case "priority":
      return { priority: v.priority };
  }
}

// =================================================================================================
// Comments and @mentions (§7.6.6, §9)
// =================================================================================================

export const COMMENT_MAX = 5000;
export const MENTION_MAX = 20;

export const AddCommentSchema = z.object({
  task_id: idField,
  body: z.string().trim().min(1, { error: "Write the comment." }).max(COMMENT_MAX, { error: `Keep it under ${COMMENT_MAX.toLocaleString("en-IN")} characters.` }),
  mentions: z.array(idField).max(MENTION_MAX, { error: `Mention at most ${MENTION_MAX} people.` }).default([]),
});
export const EditCommentSchema = z.object({
  id: idField,
  body: z.string().trim().min(1, { error: "Write the comment." }).max(COMMENT_MAX, { error: `Keep it under ${COMMENT_MAX.toLocaleString("en-IN")} characters.` }),
  mentions: z.array(idField).max(MENTION_MAX).default([]),
});
export const DeleteCommentSchema = z.object({ id: idField });

/** `@Ravi Kumar`: how a mention is written into the comment. */
export function mentionToken(name: string): string {
  return `@${name.trim()}`;
}

/**
 * The people a comment still mentions: of those picked while writing, the ones whose `@Name` is
 * still in the text (a deleted mention notifies nobody). Unique, in picking order.
 */
export function mentionsInBody(body: string, picked: ReadonlyArray<{ id: string; name: string }>): string[] {
  const out: string[] = [];
  for (const p of picked) {
    if (!p.name.trim() || out.includes(p.id)) continue;
    if (body.includes(mentionToken(p.name))) out.push(p.id);
  }
  return out;
}

/** The `@` query being typed at the caret ("@rav" → "rav"), or null when the caret isn't in a mention. */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (!m) return null;
  return { query: m[2], start: caret - m[2].length - 1 };
}

// =================================================================================================
// Checklist, dependencies, attachments
// =================================================================================================

export const AddChecklistItemSchema = z.object({
  task_id: idField,
  title: z.string().trim().min(1, { error: "Write the item." }).max(TASK_LIMITS.checklistItem, { error: `Keep it under ${TASK_LIMITS.checklistItem} characters.` }),
  due_offset_days: z
    .union([z.number().int().min(-366).max(366), z.null()])
    .optional()
    .transform((v) => (v === undefined ? null : v)),
});
export const ToggleChecklistItemSchema = z.object({ id: idField, done: z.boolean() });
export const RenameChecklistItemSchema = z.object({
  id: idField,
  title: z.string().trim().min(1, { error: "Write the item." }).max(TASK_LIMITS.checklistItem),
});
export const DeleteChecklistItemSchema = z.object({ id: idField });
export const ReorderChecklistSchema = z.object({ task_id: idField, ids: z.array(idField).min(1).max(200) });
export const ApplyTemplateSchema = z.object({ task_id: idField, template_id: z.uuid({ error: "Choose a job template." }) });

/** A checklist step's date: the task's due date less the step's offset (offsets count days before; negative = after). */
export function checklistItemDue(taskDue: DateString | null, offsetDays: number | null): DateString | null {
  if (!taskDue || offsetDays === null || offsetDays === undefined) return null;
  return addDays(taskDue, -offsetDays);
}

/** Progress for the bar: done of total, and the whole percentage (0 for an empty list). */
export function checklistProgress(done: number, total: number): { done: number; total: number; percent: number } {
  const safeTotal = Math.max(0, total);
  const safeDone = Math.min(Math.max(0, done), safeTotal);
  return { done: safeDone, total: safeTotal, percent: safeTotal === 0 ? 0 : Math.floor((safeDone * 100) / safeTotal) };
}

export const AddDependencySchema = z.object({ task_id: idField, blocker_task_id: z.uuid({ error: "Choose the blocking task." }) });
export const RemoveDependencySchema = z.object({ id: idField });

export const AttachDocumentsSchema = z.object({
  task_id: idField,
  document_ids: z.array(idField).min(1, { error: "Choose a document." }).max(20, { error: "Attach at most 20 documents at a time." }),
});
export const DetachDocumentSchema = z.object({ id: idField });

// =================================================================================================
// Saved views and filters (§7.6.1)
// =================================================================================================

export const WORK_VIEWS = ["table", "board", "calendar", "review"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

export function readWorkView(v: string | null | undefined): WorkView {
  return (WORK_VIEWS as readonly string[]).includes(v ?? "") ? (v as WorkView) : "table";
}

export const DUE_WINDOWS = ["overdue", "today", "this_week", "next_7_days", "this_month", "no_date"] as const;
export type DueWindow = (typeof DUE_WINDOWS)[number];

export const DUE_WINDOW_LABELS: Record<DueWindow, string> = {
  overdue: "Overdue",
  today: "Today",
  this_week: "This week",
  next_7_days: "Next 7 days",
  this_month: "This month",
  no_date: "No date",
};

export type DueRange = { kind: "overdue"; before: DateString } | { kind: "none" } | { kind: "range"; from: DateString; to: DateString };

/**
 * The dates a due window covers, from today in IST (§7.6.1). Weeks run Monday–Sunday. Overdue is
 * "due before today and not Filed/Done" (the caller adds the status condition).
 */
export function dueWindowRange(window: DueWindow, today: DateString): DueRange {
  switch (window) {
    case "overdue":
      return { kind: "overdue", before: today };
    case "today":
      return { kind: "range", from: today, to: today };
    case "this_week": {
      const monday = addDays(today, 1 - isoWeekday(today));
      return { kind: "range", from: monday, to: addDays(monday, 6) };
    }
    case "next_7_days":
      return { kind: "range", from: today, to: addDays(today, 7) };
    case "this_month": {
      const { year, month } = parseDateString(today);
      const first = toDateString(year, month, 1);
      return { kind: "range", from: first, to: endOfMonth(first) };
    }
    case "no_date":
      return { kind: "none" };
  }
}

/** Filter params of /work. `assignee` and `reviewer` take "me" and "none" besides people's ids. */
export const WORK_FILTERS = {
  status: TASK_STATUSES,
  assignee: null,
  reviewer: null,
  client: null,
  service: SERVICE_TYPES,
  priority: TASK_PRIORITIES,
  due: DUE_WINDOWS,
  acceptance: TASK_ACCEPTANCES,
  year: null,
  period: null,
  blockers: ["yes", "no"],
} as const;
export type WorkFilter = keyof typeof WORK_FILTERS;
export const WORK_FILTER_NAMES = Object.keys(WORK_FILTERS) as WorkFilter[];

export const WORK_SORTABLE = ["task_number", "title", "client_name", "status", "priority", "due_date", "assignee_name", "updated_at", "created_at"] as const;
export type WorkSort = (typeof WORK_SORTABLE)[number];

/** Tokens the filters accept besides ids. */
export const ME = "me";
export const NONE = "none";

const OPEN_STATUS_PARAM = OPEN_TASK_STATUSES.join(",");

export type BuiltInView = { id: string; name: string; query: string };

/**
 * The shipped saved views (§7.6.1), built in for everyone: "My open tasks", "Due this week", "Data
 * awaited", "Unassigned", "Waiting for acceptance", "Overdue". "me" means the person viewing.
 */
export const BUILT_IN_VIEWS: readonly BuiltInView[] = [
  { id: "builtin:my-open", name: "My open tasks", query: `assignee=${ME}&status=${OPEN_STATUS_PARAM}&sort=due_date&dir=asc` },
  { id: "builtin:due-week", name: "Due this week", query: `due=this_week&status=${OPEN_STATUS_PARAM}&sort=due_date&dir=asc` },
  { id: "builtin:data-awaited", name: "Data awaited", query: "status=data_awaited&sort=due_date&dir=asc" },
  { id: "builtin:unassigned", name: "Unassigned", query: `assignee=${NONE}&status=${OPEN_STATUS_PARAM}&sort=due_date&dir=asc` },
  { id: "builtin:waiting", name: "Waiting for acceptance", query: "acceptance=pending&sort=due_date&dir=asc" },
  { id: "builtin:overdue", name: "Overdue", query: "due=overdue&sort=due_date&dir=asc" },
];

/** Where an Employee lands on a bare /work: their own open tasks ("My tasks", §4.2). */
export const EMPLOYEE_DEFAULT_QUERY = BUILT_IN_VIEWS[0].query;

/**
 * Where a Partner or Manager lands on a bare /work: every open task, soonest due first. Without it the
 * table opens on months-old Filed/Done work (the earliest due dates); "Clear filters" shows everything.
 */
export const FIRM_DEFAULT_QUERY = `status=${OPEN_STATUS_PARAM}&sort=due_date&dir=asc`;

export const SaveViewSchema = z.object({
  name: z.string().trim().min(1, { error: "Name the view." }).max(60, { error: "Keep the name under 60 characters." }),
  shared: z.boolean().default(false),
  query: z.string().max(2000, { error: "This view has too many filters to save." }),
});
export const DeleteViewSchema = z.object({ id: idField });

export const BUILT_IN_VIEW_NAMES = BUILT_IN_VIEWS.map((v) => v.name.toLowerCase());

/**
 * Period labels for an FY (§5.5 `period_label`: `Sep 2026`, `Q2 2026-27`, `2026-27`), for the
 * period filter and the form's suggestions: the twelve months April–March, the four quarters, and
 * the year itself.
 */
export function periodOptionsForFy(fy: string): string[] {
  if (!isFinancialYear(fy)) return [];
  const start = fyStart(fy);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = addMonths(start, i);
    const { year, month } = parseDateString(d);
    return `${MONTH_ABBR[month - 1]} ${year}`;
  });
  const quarters = [1, 2, 3, 4].map((q) => `Q${q} ${fy}`);
  return [...months, ...quarters, fy];
}

// =================================================================================================
// Calendar view (§7.6.1)
// =================================================================================================

/** `?month=2026-10` → its first day; anything else → the month of `today`. */
export function readMonthParam(v: string | null | undefined, today: DateString): DateString {
  if (v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return `${v}-01`;
  const { year, month } = parseDateString(today);
  return toDateString(year, month, 1);
}

/** The month's grid: whole weeks Monday–Sunday covering the month (5 or 6 rows of 7 dates). */
export function monthGrid(firstOfMonth: DateString): DateString[][] {
  const start = addDays(firstOfMonth, 1 - isoWeekday(firstOfMonth));
  const last = endOfMonth(firstOfMonth);
  const end = addDays(last, 7 - isoWeekday(last));
  const weeks: DateString[][] = [];
  for (let d = start; diffDays(end, d) >= 0; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  }
  return weeks;
}

/** `2026-10` for links to the previous and next month. */
export function monthParam(firstOfMonth: DateString, deltaMonths = 0): string {
  return addMonths(firstOfMonth, deltaMonths).slice(0, 7);
}

/** `October 2026`. */
export function monthTitle(firstOfMonth: DateString): string {
  const { year, month } = parseDateString(firstOfMonth);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[month - 1]} ${year}`;
}

// =================================================================================================
// Words for notifications and the timeline (§9, §7.6.4)
// =================================================================================================

/** "T-000123 · GSTR-3B: Sep 2026": how a task is named in notices. */
export function taskRef(task: { task_number: string | null; title: string }): string {
  return task.task_number ? `${task.task_number} · ${task.title}` : task.title;
}

// =================================================================================================
// "Ask client for data" (§7.6.6, §7.6.4 Data awaited): the drafts handed to WhatsApp or Gmail
// =================================================================================================

export type AskClientFacts = {
  contactName: string | null;
  clientName: string;
  clientCode: string;
  taskTitle: string;
  period: string | null;
  serviceLabel: string | null;
  /** What is still needed: the open checklist items, or a line naming the work. */
  missing: readonly string[];
  dueDateText: string | null;
  portalLink: string;
  firmName: string;
  firmPhone: string | null;
  senderName: string;
};

/** The items as the drafts list them: one "• item" per line, or the work itself when nothing is listed. */
export function missingLines(missing: readonly string[], taskTitle: string): string[] {
  const items = missing.map((m) => m.trim()).filter(Boolean);
  return items.length ? items.map((m) => `• ${m}`) : [`• The data and documents for ${taskTitle}`];
}

/** The suggested message when no template is picked. */
export function askClientDraft(f: AskClientFacts): string {
  const hello = f.contactName ? `Hi ${f.contactName},` : "Hello,";
  const work = f.period ? `${f.taskTitle} (${f.period})` : f.taskTitle;
  const by = f.dueDateText ? ` by ${f.dueDateText}` : "";
  return [hello, "", `To complete ${work} for ${f.clientName}, we need the following${by}:`, ...missingLines(f.missing, f.taskTitle), "", `You can upload them here: ${f.portalLink}`].join("\n");
}

export function askClientSubject(f: Pick<AskClientFacts, "firmName" | "taskTitle" | "period">): string {
  return `${f.firmName} | Data needed for ${f.period ? `${f.taskTitle} (${f.period})` : f.taskTitle}`;
}

/** Values for the document-reminder templates' {{variables}} (§7.13.4). */
export function askClientValues(f: AskClientFacts) {
  return {
    client_name: f.clientName,
    client_code: f.clientCode,
    contact_name: f.contactName ?? "",
    service_type: f.serviceLabel ?? "",
    period: f.period ?? "",
    due_date: f.dueDateText ?? "",
    task_title: f.taskTitle,
    missing_items: missingLines(f.missing, f.taskTitle).join("\n"),
    portal_link: f.portalLink,
    firm_name: f.firmName,
    firm_phone: f.firmPhone ?? "",
    sender_name: f.senderName,
  };
}
