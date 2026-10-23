/**
 * Job templates and recurring tasks (§5.5, §7.6.2, §7.6.7): the template form with its steps, and
 * the recurring-task automation (task_automations, type recurring_task) with the pure schedule rules
 * the daily job follows: when it runs next, which period a run is for, the task's title and due
 * date. Shared by the forms (client), server/actions/{job-templates,task-automations}.ts and
 * server/jobs/recurring-tasks.ts. Client-safe.
 *
 * Step offsets (job_template_items.offset_days) count days BEFORE the job's due date; a negative
 * offset is after it (§5.5).
 */

import { z } from "zod";
import { SERVICE_TYPES, TASK_PRIORITIES, type ServiceType, type TaskPriority } from "@/lib/domain/enums";
import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  financialYearOf,
  isDateString,
  isoWeekday,
  MONTH_ABBR,
  monthPeriodLabel,
  parseDateString,
  quarterLabel,
  toDateString,
  type DateString,
} from "@/lib/domain/fy";

// =================================================================================================
// Job template form
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
const wholeNumber = (min: number, max: number, error: string) =>
  z
    .union([z.number(), z.string().trim()])
    .refine((v) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max, { error })
    .transform((v) => Number(v));
const optionalWholeNumber = (min: number, max: number, error: string) =>
  z
    .union([z.number(), z.string().trim(), z.null()])
    .optional()
    .refine((v) => v === undefined || v === null || v === "" || (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max), { error })
    .transform((v) => (v === undefined || v === null || v === "" ? null : Number(v)));

export const TEMPLATE_STEP_MAX = 100;

export const JobTemplateItemSchema = z.object({
  id: optionalId("Reload the page and try again."),
  title: z.string().trim().min(1, { error: "Write the step." }).max(300, { error: "Keep the step under 300 characters." }),
  description: optionalText(2000),
  /** Days before the due date (negative: after). */
  offset_days: wholeNumber(-366, 366, "Enter whole days between -366 and 366."),
});

export const JobTemplateSchema = z.object({
  id: optionalId("Reload the page and try again."),
  expected_updated_at: z.string().nullish(),
  name: z.string().trim().min(1, { error: "Name the template." }).max(120, { error: "Keep the name under 120 characters." }),
  service_type: z.enum(SERVICE_TYPES, { error: "Choose the service." }),
  description: optionalText(2000),
  default_lead_days: optionalWholeNumber(0, 366, "Enter whole days between 0 and 366."),
  is_active: z.boolean().default(true),
  items: z
    .array(JobTemplateItemSchema)
    .min(1, { error: "Add at least one step." })
    .max(TEMPLATE_STEP_MAX, { error: `A template can have at most ${TEMPLATE_STEP_MAX} steps.` }),
});
export type JobTemplateInput = z.input<typeof JobTemplateSchema>;
export type JobTemplateOutput = z.output<typeof JobTemplateSchema>;

export const DeleteJobTemplateSchema = z.object({ id: idField });
export const SetTemplateActiveSchema = z.object({ id: idField, is_active: z.boolean(), expected_updated_at: z.string().min(1) });

/** "9 days before", "on the due date", "15 days after" (a step's offset in words). */
export function offsetLabel(offsetDays: number): string {
  if (offsetDays === 0) return "On the due date";
  const n = Math.abs(offsetDays);
  return `${n} ${n === 1 ? "day" : "days"} ${offsetDays > 0 ? "before" : "after"}`;
}

/** The steps in date order relative to the due date: earliest (largest offset) first, ties in list order. */
export function stepsInDateOrder<T extends { offset_days: number }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.offset_days - a.item.offset_days || a.i - b.i)
    .map((x) => x.item);
}

// =================================================================================================
// Recurring tasks (§7.6.7)
// =================================================================================================

export const RECURRING_FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const RECURRING_FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  weekly: "Every week",
  monthly: "Every month",
  quarterly: "Every quarter",
  yearly: "Every year",
};

/** The token in a recurring task's title that becomes the period ("GSTR-3B: {period}" → "GSTR-3B: Oct 2026"). */
export const PERIOD_TOKEN = "{period}";

/** What a recurring-task automation stores in task_automations.config. */
export type RecurringConfig = {
  title: string;
  description: string | null;
  job_template_id: string | null;
  service_type: ServiceType | null;
  priority: TaskPriority;
  estimated_minutes: number | null;
  assignee_employee_id: string | null;
  reviewer_employee_id: string | null;
  /** Day of the month the task is created (1–28): monthly, quarterly and yearly. */
  run_day: number;
  /** Month of the year (1–12): yearly only. */
  run_month: number | null;
  /** ISO weekday (1 = Monday): weekly only. */
  run_weekday: number | null;
  /** 0: the task is for the current period; 1: for the period just ended (the usual case for returns). */
  period_offset: 0 | 1;
  /** The task is due this many days after it is created. */
  due_after_days: number;
};

export type RecurringSchedule = Pick<RecurringConfig, "run_day" | "run_month" | "run_weekday" | "period_offset" | "due_after_days"> & {
  frequency: RecurringFrequency;
};

const QUARTER_START_MONTHS = [1, 4, 7, 10];

/** The run date in the month of `date` (the run day clamped to the month). */
function runInMonth(date: DateString, runDay: number): DateString {
  const { year, month } = parseDateString(date);
  return toDateString(year, month, Math.min(runDay, daysInMonth(year, month)));
}

function isRunMonth(month: number, s: RecurringSchedule): boolean {
  if (s.frequency === "monthly") return true;
  if (s.frequency === "quarterly") return QUARTER_START_MONTHS.includes(month);
  return month === (s.run_month ?? 4);
}

/** The first run date on or after `from`. */
export function firstRunOnOrAfter(s: RecurringSchedule, from: DateString): DateString {
  if (s.frequency === "weekly") {
    const wd = s.run_weekday ?? 1;
    return addDays(from, (wd - isoWeekday(from) + 7) % 7);
  }
  const first = toDateString(parseDateString(from).year, parseDateString(from).month, 1);
  for (let i = 0; i < 24; i++) {
    const monthStart = addMonths(first, i);
    if (!isRunMonth(parseDateString(monthStart).month, s)) continue;
    const run = runInMonth(monthStart, s.run_day);
    if (diffDays(run, from) >= 0) return run;
  }
  throw new RangeError("No run date within two years: check the schedule.");
}

/** The run date after `previous` (strictly later). */
export function nextRunAfter(s: RecurringSchedule, previous: DateString): DateString {
  return firstRunOnOrAfter(s, addDays(previous, 1));
}

/** The period a run creates the task for (§5.5 period_label) and its FY. */
export function periodForRun(s: RecurringSchedule, runDate: DateString): { label: string; financialYear: string } {
  switch (s.frequency) {
    case "weekly": {
      const monday = addDays(runDate, 1 - isoWeekday(runDate) - 7 * s.period_offset);
      const { day, month, year } = parseDateString(monday);
      return { label: `Week of ${String(day).padStart(2, "0")} ${MONTH_ABBR[month - 1]} ${year}`, financialYear: financialYearOf(monday) };
    }
    case "monthly": {
      const d = addMonths(runDate, -s.period_offset);
      return { label: monthPeriodLabel(d), financialYear: financialYearOf(d) };
    }
    case "quarterly": {
      const d = addMonths(runDate, -3 * s.period_offset);
      return { label: quarterLabel(d), financialYear: financialYearOf(d) };
    }
    case "yearly": {
      const d = addMonths(runDate, -12 * s.period_offset);
      const fy = financialYearOf(d);
      return { label: fy, financialYear: fy };
    }
  }
}

/** The task title for a period: the `{period}` token replaced, or the period added after a dash. */
export function recurringTitle(template: string, periodLabel: string): string {
  const t = template.trim();
  return t.includes(PERIOD_TOKEN) ? t.split(PERIOD_TOKEN).join(periodLabel) : `${t} – ${periodLabel}`;
}

export type PlannedRun = { runDate: DateString; period: string; financialYear: string; title: string; dueDate: DateString };

/** Everything one run creates. */
export function planRun(s: RecurringSchedule, title: string, runDate: DateString): PlannedRun {
  const p = periodForRun(s, runDate);
  return { runDate, period: p.label, financialYear: p.financialYear, title: recurringTitle(title, p.label), dueDate: addDays(runDate, s.due_after_days) };
}

/** At most this many missed runs are caught up in one go (the latest ones); older ones are skipped and reported. */
export const MAX_CATCH_UP_RUNS = 3;

/**
 * The runs due by `today` from the stored next run date, and the next run after them (§7.6.7).
 * When the job was down for a while, only the latest MAX_CATCH_UP_RUNS are made; `skipped` counts
 * the older ones.
 */
export function dueRuns(s: RecurringSchedule, nextRun: DateString, today: DateString): { runs: DateString[]; skipped: number; next: DateString } {
  const all: DateString[] = [];
  let d = nextRun;
  let guard = 0;
  while (diffDays(today, d) >= 0 && guard < 400) {
    all.push(d);
    d = nextRunAfter(s, d);
    guard++;
  }
  const runs = all.slice(-MAX_CATCH_UP_RUNS);
  return { runs, skipped: all.length - runs.length, next: d };
}

/** "On the 1st of every month, for the month just ended; due 19 days later." */
export function describeSchedule(s: RecurringSchedule): string {
  const ord = (n: number) => {
    const v = n % 100;
    const suffix = v >= 11 && v <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
    return `${n}${suffix}`;
  };
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const due = s.due_after_days === 0 ? "due the same day" : `due ${s.due_after_days} ${s.due_after_days === 1 ? "day" : "days"} later`;
  switch (s.frequency) {
    case "weekly":
      return `Every ${weekdays[(s.run_weekday ?? 1) - 1]}, for ${s.period_offset ? "the week just ended" : "that week"}; ${due}.`;
    case "monthly":
      return `On the ${ord(s.run_day)} of every month, for ${s.period_offset ? "the month just ended" : "that month"}; ${due}.`;
    case "quarterly":
      return `On the ${ord(s.run_day)} of April, July, October and January, for ${s.period_offset ? "the quarter just ended" : "that quarter"}; ${due}.`;
    case "yearly":
      return `On ${ord(s.run_day)} ${months[(s.run_month ?? 4) - 1]} every year, for ${s.period_offset ? "the financial year just ended" : "that financial year"}; ${due}.`;
  }
}

/** Reads a stored config, filling defaults; null when it can't be used (no title, or not an object). */
export function readRecurringConfig(value: unknown): RecurringConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!title) return null;
  const int = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);
  const id = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  return {
    title,
    description: typeof o.description === "string" && o.description.trim() ? o.description.trim() : null,
    job_template_id: id(o.job_template_id),
    service_type: typeof o.service_type === "string" && (SERVICE_TYPES as readonly string[]).includes(o.service_type) ? (o.service_type as ServiceType) : null,
    priority: typeof o.priority === "string" && (TASK_PRIORITIES as readonly string[]).includes(o.priority) ? (o.priority as TaskPriority) : "medium",
    estimated_minutes: typeof o.estimated_minutes === "number" && o.estimated_minutes >= 0 ? Math.round(o.estimated_minutes) : null,
    assignee_employee_id: id(o.assignee_employee_id),
    reviewer_employee_id: id(o.reviewer_employee_id),
    run_day: int(o.run_day, 1, 28, 1),
    run_month: typeof o.run_month === "number" ? int(o.run_month, 1, 12, 4) : null,
    run_weekday: typeof o.run_weekday === "number" ? int(o.run_weekday, 1, 7, 1) : null,
    period_offset: o.period_offset === 0 ? 0 : 1,
    due_after_days: int(o.due_after_days, 0, 366, 0),
  };
}

export const AutomationSchema = z
  .object({
    id: optionalId("Reload the page and try again."),
    expected_updated_at: z.string().nullish(),
    client_id: z.uuid({ error: "Choose the client." }),
    title: z
      .string()
      .trim()
      .min(1, { error: "Give the recurring task a title." })
      .max(250, { error: "Keep the title under 250 characters." }),
    description: optionalText(2000),
    job_template_id: optionalId("Choose the template again."),
    service_type: z
      .union([z.enum(SERVICE_TYPES), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    priority: z.enum(TASK_PRIORITIES).default("medium"),
    estimated_minutes: optionalWholeNumber(0, 100000, "Enter the estimate in whole minutes."),
    assignee_employee_id: optionalId("Choose who does it."),
    reviewer_employee_id: optionalId("Choose the reviewer."),
    frequency: z.enum(RECURRING_FREQUENCIES, { error: "Choose how often." }),
    run_day: wholeNumber(1, 28, "Choose a day from 1 to 28."),
    run_month: optionalWholeNumber(1, 12, "Choose the month."),
    run_weekday: optionalWholeNumber(1, 7, "Choose the day of the week."),
    period_offset: z
      .union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")])
      .default(1)
      .transform((v) => (Number(v) === 0 ? 0 : 1) as 0 | 1),
    due_after_days: wholeNumber(0, 366, "Enter whole days between 0 and 366."),
    is_active: z.boolean().default(true),
    starts_on: z
      .string()
      .nullish()
      .refine((v) => !v || isDateString(v), { error: "Choose the first date it may run." })
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.assignee_employee_id && v.assignee_employee_id === v.reviewer_employee_id) {
      ctx.addIssue({ code: "custom", path: ["reviewer_employee_id"], message: "The reviewer can't also be the assignee: nobody reviews their own work." });
    }
    if (v.frequency === "yearly" && v.run_month === null) ctx.addIssue({ code: "custom", path: ["run_month"], message: "Choose the month." });
    if (v.frequency === "weekly" && v.run_weekday === null) ctx.addIssue({ code: "custom", path: ["run_weekday"], message: "Choose the day of the week." });
  });
export type AutomationInput = z.input<typeof AutomationSchema>;
export type AutomationOutput = z.output<typeof AutomationSchema>;

export const SetAutomationActiveSchema = z.object({ id: idField, is_active: z.boolean() });
export const DeleteAutomationSchema = z.object({ id: idField });

/** The config object stored for a saved automation. */
export function automationConfig(v: AutomationOutput): RecurringConfig {
  return {
    title: v.title,
    description: v.description,
    job_template_id: v.job_template_id,
    service_type: v.service_type,
    priority: v.priority,
    estimated_minutes: v.estimated_minutes,
    assignee_employee_id: v.assignee_employee_id,
    reviewer_employee_id: v.reviewer_employee_id,
    run_day: v.run_day,
    run_month: v.frequency === "yearly" ? v.run_month : null,
    run_weekday: v.frequency === "weekly" ? v.run_weekday : null,
    period_offset: v.period_offset,
    due_after_days: v.due_after_days,
  };
}

/** The moment a run date starts in IST, for task_automations.next_run_at (the job runs after it). */
export function runInstant(runDate: DateString): string {
  if (!isDateString(runDate)) throw new RangeError(`Not a date: ${runDate}`);
  return `${runDate}T00:00:00+05:30`;
}
