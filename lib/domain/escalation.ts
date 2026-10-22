/**
 * Time-driven escalation: overdue task levels (§7.6.7, §8, §9), plus the two other schedules the
 * daily jobs run from parameters: quotation follow-ups on day 3, 7 and 14 (§7.5.3) and appeal
 * limitation dates for notices closed unfavourably (§7.8.4).
 *
 * - **Escalation (08:00 daily job):** overdue > 3 days → level 1 (notify the assignee and
 *   Managers); > 7 days → level 2 (notify Partners). Idempotent: a level is reached once, and the
 *   job never lowers it. It re-arms (back to 0) after a reopen or a due-date change. Overdue is
 *   derived (`status <> filed_done and due_date < today`), never stored.
 * - **Quotation follow-ups:** day 3, 7 and 14 after sending, while the quotation is still Sent or
 *   Viewed and not past `valid_until`.
 * - **Appeal limitation:** IT first appeal 30 days from the order; ITAT 60 days; GST first appeal
 *   3 months; GST Appellate Tribunal 3 months. All four are [verify] and seeded unverified.
 *
 * Every number is a parameter (`ESCALATION_DEFAULTS`, `FOLLOW_UP_DEFAULTS`, `APPEAL_DEFAULTS`,
 * seeded by `ESCALATION_SEED_PARAMETERS`). Pure and client-safe; "today" is passed in.
 */

import type { QuotationStatus, TaskStatus } from "@/lib/domain/enums";
import { addDays, addMonths, diffDays, type DateString } from "@/lib/domain/fy";
import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce, readParameterNumber } from "@/lib/domain/gst";

// -------------------------------------------------------------------------------------------------
// Parameters
// -------------------------------------------------------------------------------------------------

export type EscalationParams = {
  /** Level 1 when overdue by MORE than this many days. */
  level1AfterDays: number;
  /** Level 2 when overdue by MORE than this many days. */
  level2AfterDays: number;
};

/** §7.6.7: > 3 days → level 1, > 7 days → level 2. */
export const ESCALATION_DEFAULTS: EscalationParams = { level1AfterDays: 3, level2AfterDays: 7 };

/** §7.5.3: follow-ups on day 3, 7 and 14 after sending. */
export const FOLLOW_UP_DEFAULTS = { quotationFollowUpDays: [3, 7, 14] as readonly number[] };

/** A limitation period: days or calendar months from the order date. */
export type LimitationPeriod = { days: number } | { months: number };

export type AppealForum = "income_tax_first_appeal" | "income_tax_tribunal" | "gst_first_appeal" | "gst_tribunal";

/** §7.8.4 appeal limitation periods, each [verify] against the current statute. */
export const APPEAL_DEFAULTS: Record<AppealForum, LimitationPeriod> = {
  income_tax_first_appeal: { days: 30 },
  income_tax_tribunal: { days: 60 },
  gst_first_appeal: { months: 3 },
  gst_tribunal: { months: 3 },
};

export const APPEAL_FORUM_LABELS: Record<AppealForum, string> = {
  income_tax_first_appeal: "Income tax: first appeal (CIT(A))",
  income_tax_tribunal: "Income tax: Appellate Tribunal (ITAT)",
  gst_first_appeal: "GST: first appeal (Appellate Authority)",
  gst_tribunal: "GST: Appellate Tribunal (GSTAT)",
};

/** The `statutory_parameters` keys this module reads (documented in the seed file too). */
export const ESCALATION_PARAM_KEYS = {
  /** `{"level1": 3, "level2": 7}`: overdue days after which a task escalates. */
  overdueDays: "escalation.overdue_days",
  /** `[3, 7, 14]`: quotation follow-up days after sending. */
  quotationFollowUpDays: "quotation.follow_up_days",
  /** `{"days": 30}`: income-tax first appeal. */
  incomeTaxFirstAppeal: "appeal.income_tax.first_appeal",
  /** `{"days": 60}`: Income Tax Appellate Tribunal. */
  incomeTaxTribunal: "appeal.income_tax.tribunal",
  /** `{"months": 3}`: GST first appeal. */
  gstFirstAppeal: "appeal.gst.first_appeal",
  /** `{"months": 3}`: GST Appellate Tribunal. */
  gstTribunal: "appeal.gst.tribunal",
} as const;

const APPEAL_KEYS: Record<AppealForum, string> = {
  income_tax_first_appeal: ESCALATION_PARAM_KEYS.incomeTaxFirstAppeal,
  income_tax_tribunal: ESCALATION_PARAM_KEYS.incomeTaxTribunal,
  gst_first_appeal: ESCALATION_PARAM_KEYS.gstFirstAppeal,
  gst_tribunal: ESCALATION_PARAM_KEYS.gstTribunal,
};

const FIRM_PRACTICE = "Firm practice";
const IT_ACT_1961 = "Income-tax Act, 1961";
const CGST_ACT = "Central Goods and Services Tax Act, 2017";

/**
 * The escalation, quotation follow-up and appeal-limitation rows of
 * `supabase/seed/42_params_practice.sql` (§16). The appeal periods are [verify] (§7.8.4), so they
 * are seeded unverified.
 */
export const ESCALATION_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: ESCALATION_PARAM_KEYS.overdueDays,
    value: { level1: ESCALATION_DEFAULTS.level1AfterDays, level2: ESCALATION_DEFAULTS.level2AfterDays },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: FIRM_PRACTICE,
    sectionRef: "§7.6.7 escalation",
    sourceRef: "TaxWise Practice OS specification §7.6.7, §8",
    notes: "A task overdue by more than 3 days reaches level 1 (the assignee and Managers are told); by more than 7 days, level 2 (Partners are told). Re-arms after a reopen or a due-date change.",
    verified: true,
  },
  {
    key: ESCALATION_PARAM_KEYS.quotationFollowUpDays,
    value: [...FOLLOW_UP_DEFAULTS.quotationFollowUpDays],
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: FIRM_PRACTICE,
    sectionRef: "§7.5.3 quotation follow-ups",
    sourceRef: "TaxWise Practice OS specification §7.5.3",
    notes: "Automatic follow-ups on day 3, 7 and 14 after a quotation is sent, while it is still Sent or Viewed and not expired. firm_settings.quotation_follow_up_days is the copy used at run time.",
    verified: true,
  },
  {
    key: ESCALATION_PARAM_KEYS.incomeTaxFirstAppeal,
    value: { days: 30 },
    effectiveFrom: "1962-04-01",
    effectiveTo: null,
    statute: IT_ACT_1961,
    sectionRef: "s.249(2) [verify] the Income-tax Act, 2025 equivalent",
    sourceRef: "Income-tax Act, 1961, s.249(2)",
    notes: "First appeal to the CIT(A): 30 days from the order (strictly, from service of the order or demand notice). [verify] against the current statute before relying on it (§7.8.4).",
    verified: false,
  },
  {
    key: ESCALATION_PARAM_KEYS.incomeTaxTribunal,
    value: { days: 60 },
    effectiveFrom: "1962-04-01",
    effectiveTo: null,
    statute: IT_ACT_1961,
    sectionRef: "s.253(3) [verify] the Income-tax Act, 2025 equivalent",
    sourceRef: "Income-tax Act, 1961, s.253(3)",
    notes: "Appeal to the Income Tax Appellate Tribunal: 60 days from the date the order is communicated. [verify] against the current statute before relying on it (§7.8.4).",
    verified: false,
  },
  {
    key: ESCALATION_PARAM_KEYS.gstFirstAppeal,
    value: { months: 3 },
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.107(1) [verify]",
    sourceRef: "CGST Act, 2017, s.107(1)",
    notes: "First appeal to the Appellate Authority: 3 months from the date the order is communicated. [verify] against the current statute before relying on it (§7.8.4).",
    verified: false,
  },
  {
    key: ESCALATION_PARAM_KEYS.gstTribunal,
    value: { months: 3 },
    effectiveFrom: "2017-07-01",
    effectiveTo: null,
    statute: CGST_ACT,
    sectionRef: "s.112(1) [verify]",
    sourceRef: "CGST Act, 2017, s.112(1)",
    notes: "Appeal to the GST Appellate Tribunal: 3 months from the date the order appealed against is communicated. [verify] against the current statute and the GSTAT notifications before relying on it (§7.8.4).",
    verified: false,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads `{"days": n}` or `{"months": n}` (positive whole numbers), or null. */
export function readLimitationPeriod(value: unknown): LimitationPeriod | null {
  const o = asRecord(value);
  if (!o) return null;
  if (typeof o.days === "number" && Number.isInteger(o.days) && o.days > 0) return { days: o.days };
  if (typeof o.months === "number" && Number.isInteger(o.months) && o.months > 0) return { months: o.months };
  return null;
}

export type ResolvedEscalationParams = {
  escalation: EscalationParams;
  quotationFollowUpDays: number[];
  appeals: Record<AppealForum, LimitationPeriod>;
  /** Keys with no usable row on the date (the default was used). */
  missing: string[];
  /** Keys whose row in force is not yet verified by a Partner. */
  unverified: string[];
};

/** The parameters in force on a date (§5.12), each falling back to its default when missing. */
export function resolveEscalationParams(rows: readonly StatutoryParameterRow[], on: DateString): ResolvedEscalationParams {
  const missing: string[] = [];
  const unverified: string[] = [];
  const read = <T>(key: string, parse: (v: unknown) => T | null, fallback: T): T => {
    const row = parameterInForce(rows, key, on);
    const parsed = row ? parse(row.value) : null;
    if (parsed === null) {
      missing.push(key);
      return fallback;
    }
    if (row && row.verified === false) unverified.push(key);
    return parsed;
  };
  const escalation = read(
    ESCALATION_PARAM_KEYS.overdueDays,
    (v) => {
      const o = asRecord(v);
      const l1 = readParameterNumber(o?.level1);
      const l2 = readParameterNumber(o?.level2);
      return l1 !== null && l2 !== null && l1 >= 0 && l1 < l2 ? { level1AfterDays: l1, level2AfterDays: l2 } : null;
    },
    { ...ESCALATION_DEFAULTS },
  );
  const quotationFollowUpDays = read(
    ESCALATION_PARAM_KEYS.quotationFollowUpDays,
    (v) => (Array.isArray(v) && v.length > 0 && v.every((d) => Number.isInteger(d) && (d as number) > 0) ? [...(v as number[])].sort((a, b) => a - b) : null),
    [...FOLLOW_UP_DEFAULTS.quotationFollowUpDays],
  );
  const appeals = {} as Record<AppealForum, LimitationPeriod>;
  for (const forum of Object.keys(APPEAL_DEFAULTS) as AppealForum[]) {
    appeals[forum] = read(APPEAL_KEYS[forum], readLimitationPeriod, APPEAL_DEFAULTS[forum]);
  }
  return { escalation, quotationFollowUpDays, appeals, missing, unverified };
}

// -------------------------------------------------------------------------------------------------
// Task escalation (§7.6.7)
// -------------------------------------------------------------------------------------------------

export type EscalationLevel = 0 | 1 | 2;

/**
 * Days a task is overdue (derived, §5.5 `tasks_view`): `today − due_date` when not Filed/Done and the
 * due date has passed; 0 otherwise (no due date, filed, due today or later).
 */
export function daysOverdue(dueDate: DateString | null, today: DateString, status: TaskStatus): number {
  if (dueDate === null || status === "filed_done") return 0;
  const d = diffDays(today, dueDate);
  return d > 0 ? d : 0;
}

/** The level a number of overdue days calls for: > level 2 days → 2; > level 1 days → 1; else 0. */
export function escalationLevelFor(overdueDays: number, params: EscalationParams = ESCALATION_DEFAULTS): EscalationLevel {
  if (overdueDays > params.level2AfterDays) return 2;
  if (overdueDays > params.level1AfterDays) return 1;
  return 0;
}

export type EscalationAudience = { assignee: boolean; managers: boolean; partners: boolean };

export type EscalationDecision = {
  /** The level to store (never lower than the current one). */
  level: EscalationLevel;
  /** True when the job should write: the level rose, so `escalated_at = now`. */
  changed: boolean;
  /** The levels newly reached on this run, in order (both when jumping from 0 to 2). */
  reached: EscalationLevel[];
  /** Who is told: the assignee on any new level; Managers at level 1; Partners at level 2 (§9). */
  notify: EscalationAudience;
  daysOverdue: number;
};

/**
 * The daily escalation step for one task (§7.6.7, §8). Idempotent: running it twice on the same day
 * changes nothing the second time, and it never lowers a level (re-arming is explicit, see
 * `rearmEscalation`). Filed/Done tasks never escalate.
 */
export function planEscalation(
  input: { status: TaskStatus; dueDate: DateString | null; currentLevel: number; today: DateString },
  params: EscalationParams = ESCALATION_DEFAULTS,
): EscalationDecision {
  const overdue = daysOverdue(input.dueDate, input.today, input.status);
  const current = Math.max(0, Math.min(2, Math.trunc(input.currentLevel))) as EscalationLevel;
  const target = escalationLevelFor(overdue, params);
  if (target <= current) {
    return { level: current, changed: false, reached: [], notify: { assignee: false, managers: false, partners: false }, daysOverdue: overdue };
  }
  const reached: EscalationLevel[] = [];
  for (let l = current + 1; l <= target; l++) reached.push(l as EscalationLevel);
  return {
    level: target,
    changed: true,
    reached,
    notify: { assignee: true, managers: reached.includes(1), partners: reached.includes(2) },
    daysOverdue: overdue,
  };
}

/** The re-armed state written on a reopen or a due-date change (§7.6.7): level 0, no escalated_at. */
export function rearmEscalation(): { escalationLevel: 0; escalatedAt: null } {
  return { escalationLevel: 0, escalatedAt: null };
}

/** True when a due-date change re-arms escalation: the date actually changed (incl. set or cleared). */
export function dueDateChangeRearms(oldDue: DateString | null, newDue: DateString | null): boolean {
  return oldDue !== newDue;
}

// -------------------------------------------------------------------------------------------------
// Quotation follow-ups (§7.5.3)
// -------------------------------------------------------------------------------------------------

/** The follow-up schedule after sending: `[{ day: 3, dueOn }, …]` (`quotation_follow_ups.scheduled_at`). */
export function quotationFollowUpSchedule(sentOn: DateString, days: readonly number[] = FOLLOW_UP_DEFAULTS.quotationFollowUpDays): { day: number; dueOn: DateString }[] {
  return [...days].sort((a, b) => a - b).map((day) => ({ day, dueOn: addDays(sentOn, day) }));
}

/**
 * The follow-ups the 14:30 job sends today (§7.5.3): those whose day has come, not already sent or
 * skipped, while the quotation is still Sent or Viewed and not past `valid_until`.
 */
export function quotationFollowUpsDue(input: {
  sentOn: DateString;
  today: DateString;
  status: QuotationStatus;
  validUntil: DateString;
  /** Follow-up days already sent, skipped or failed. */
  done: readonly number[];
  days?: readonly number[];
}): number[] {
  if (input.status !== "sent" && input.status !== "viewed") return [];
  if (diffDays(input.today, input.validUntil) > 0) return [];
  return quotationFollowUpSchedule(input.sentOn, input.days)
    .filter((f) => diffDays(input.today, f.dueOn) >= 0 && !input.done.includes(f.day))
    .map((f) => f.day);
}

// -------------------------------------------------------------------------------------------------
// Appeal limitation (§7.8.4)
// -------------------------------------------------------------------------------------------------

/** The last day to appeal: the order date plus the period (calendar months clamp to month end). */
export function limitationDate(orderDate: DateString, period: LimitationPeriod): DateString {
  return "days" in period ? addDays(orderDate, period.days) : addMonths(orderDate, period.months);
}

/** The limitation date for a forum, from the resolved (or default) periods. */
export function appealLimitationDate(forum: AppealForum, orderDate: DateString, appeals: Record<AppealForum, LimitationPeriod> = APPEAL_DEFAULTS): DateString {
  return limitationDate(orderDate, appeals[forum]);
}

/** Days left to appeal (negative once the limitation date has passed). */
export function daysToLimitation(limitation: DateString, today: DateString): number {
  return diffDays(limitation, today);
}
