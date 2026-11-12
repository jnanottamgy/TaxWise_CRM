/**
 * Law & rules (§5.12, §7.21): statutory parameters, due-date rules, government extensions and the
 * 1961 ↔ 2025 section concordance. Statutory numbers are data, not code; this page edits them
 * without overwriting history: a change closes the row in force (`effective_to`) and adds a new
 * row from a date.
 *
 * Client-safe: pure, no server imports. Shared by the forms and server/actions/law.ts.
 */

import { z } from "zod";
import { COMPLIANCE_TYPES, SERVICE_FREQUENCIES, type ServiceFrequency } from "@/lib/domain/enums";
import { addDays, compareDates, isDateString, type DateString } from "@/lib/domain/fy";
import { parseAppliesTo, parseRuleSpec } from "@/lib/domain/statutory-calendar";
import { formatDate } from "@/lib/format";
import { concurrencyToken, optionalText } from "@/lib/schemas/settings";

// -------------------------------------------------------------------------------------------------
// Parameter values: typed as text, stored as jsonb
// -------------------------------------------------------------------------------------------------

export type ParameterValueParse = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Reads what a Partner typed as a parameter value: a plain number (`18`, `50000`, `0.5`) becomes a
 * number; JSON (`{"rate": 10}`, `[0, 5, 18, 40]`, `"text"`, `true`) is parsed; any other text is
 * kept as a string. Empty is refused.
 */
export function parseParameterValue(text: string): ParameterValueParse {
  const t = text.trim();
  if (t === "") return { ok: false, error: "Enter the value." };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  if (/^[{["]/.test(t) || t === "true" || t === "false" || t === "null") {
    try {
      const value: unknown = JSON.parse(t);
      if (value === null) return { ok: false, error: "Enter the value (null isn't a value)." };
      return { ok: true, value };
    } catch {
      return { ok: false, error: "That looks like JSON but doesn't parse. Check the brackets, quotes and commas." };
    }
  }
  return { ok: true, value: t };
}

/** The value as the edit field shows it: the inverse of `parseParameterValue`. */
export function formatParameterValue(value: unknown, opts: { pretty?: boolean } = {}): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // A string that would read back as a number or JSON keeps its quotes.
    return /^-?\d+(\.\d+)?$/.test(value.trim()) || /^[{["]/.test(value.trim()) || ["true", "false", "null"].includes(value.trim())
      ? JSON.stringify(value)
      : value;
  }
  return opts.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** One line for tables: short JSON, cut at `max` characters. */
export function summariseParameterValue(value: unknown, max = 60): string {
  const text = formatParameterValue(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const valueNumber = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 });

/** Durations: `{ months: 3 }` reads "3 months"; a key ending `_days` gives its plain number the unit. */
const DURATION_UNITS = ["minutes", "hours", "days", "weeks", "months", "years"] as const;
const SINGULAR: Record<string, string> = { minutes: "minute", hours: "hour", days: "day", weeks: "week", months: "month", years: "year" };

/** Field names that hold rupees (whole rupees, as the law states them). */
const MONEY_FIELD = /^(amount|annual|limit|limit_?low_?cash|turnover|turnover_?up_?to|paid_?up_?capital|revenue|borrowings|capital_?and_?reserves|max_?turnover|max_?turnover_?low_?cash|max_?receipts|max_?receipts_?low_?cash|threshold)$/i;
/** Field names that hold a percentage. */
const PERCENT_FIELD = /(^rate$|pct|percent)/i;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function duration(n: number, unit: string): string {
  return `${valueNumber.format(n)} ${n === 1 ? SINGULAR[unit] : unit}`;
}

/** Rupees as a CA says them: ₹50,000 · ₹7.5 lakh · ₹5 crore (whole rupees in). */
function rupees(n: number): string {
  const abs = Math.abs(n);
  const words = (value: number, unit: string) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value)} ${unit}`;
  if (abs >= 1_00_00_000) return words(n / 1_00_00_000, "crore");
  if (abs >= 1_00_000) return words(n / 1_00_000, "lakh");
  return `₹${valueNumber.format(n)}`;
}

function label(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** What a field's name says about its unit: "days", "₹", "%", or nothing. */
function unitOf(key: string | undefined): string | null {
  if (!key) return null;
  const k = key.toLowerCase();
  for (const u of DURATION_UNITS) if (k === u || k.endsWith(`_${u}`) || k.includes(`_${u}_`)) return u;
  if (MONEY_FIELD.test(key)) return "₹";
  if (PERCENT_FIELD.test(key) || /(^|[._])(rate|slabs)([._]|$)/.test(k)) return "%";
  return null;
}

function scalar(v: number, unit: string | null): string {
  if (unit === "₹") return rupees(v);
  if (unit === "%") return `${valueNumber.format(v)}%`;
  if (unit) return duration(v, unit);
  return valueNumber.format(v);
}

function describePart(v: unknown, key?: string, inherited: string | null = null): string {
  if (v === null || v === undefined) return "—";
  const unit = unitOf(key) ?? inherited;
  if (typeof v === "number") return scalar(v, unit);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return key === "section" ? `s.${v}` : key === "per" ? `per ${v}` : v;
  if (Array.isArray(v)) {
    if (!v.length) return "none";
    // A list of plain numbers carries the unit once: "3, 7, 14 days"; percentages each: "0%, 5%, 18%".
    if (unit && unit !== "%" && unit !== "₹" && v.every((x) => typeof x === "number")) return `${v.map((x) => valueNumber.format(x as number)).join(", ")} ${unit}`;
    return v.map((x) => describePart(x, key, inherited)).join(", ");
  }
  if (typeof v === "object") {
    const o = { ...(v as Record<string, unknown>) };
    const lead: string[] = [];
    // A calendar day: { day: 30, month: 11 } reads "30 November".
    if (typeof o.day === "number" && typeof o.month === "number" && o.month >= 1 && o.month <= 12) {
      const offset = typeof o.yearOffset === "number" && o.yearOffset !== 0 ? ` (year ${o.yearOffset > 0 ? "+" : ""}${o.yearOffset})` : "";
      lead.push(`${o.day} ${MONTH_NAMES[o.month - 1]}${offset}`);
      delete o.day;
      delete o.month;
      delete o.yearOffset;
    }
    // A period counted from the end of a month: { months: 2, from: "month_end" } reads
    // "2 months from the end of the month".
    if (typeof o.months === "number" && o.from === "month_end") {
      lead.push(`${o.months} ${o.months === 1 ? "month" : "months"} from the end of the month`);
      delete o.months;
      delete o.from;
    }
    // An amount for a period: { per: "year", amount: 15000 } reads "₹15,000 per year".
    if (typeof o.amount === "number" && typeof o.per === "string") {
      lead.push(`${rupees(o.amount)} per ${o.per}`);
      delete o.amount;
      delete o.per;
    }
    const rest = Object.entries(o).map(([k, x]) => {
      const nested = x !== null && typeof x === "object" && !Array.isArray(x);
      if (nested) return `${label(k)} (${describePart(x, k, unit)})`;
      // Fields whose name is the unit read as the value alone: "3 months", "2%", "s.194H", "₹5 crore".
      if ((DURATION_UNITS as readonly string[]).includes(k) || k === "rate" || k === "section" || k === "per" || k === "amount") return describePart(x, k);
      return `${label(k)} ${describePart(x, k, unit)}`;
    });
    return [...lead, ...rest].join(" · ");
  }
  return String(v);
}

/**
 * The value in words for the parameters table, so a Partner reads it rather than parses it:
 * `{"months":3}` → "3 months"; `{"amount":50000,"inclusive":false}` → "₹50,000 · inclusive no";
 * `{"rate":2,"section":"194H"}` → "2% · s.194H"; `{"per":"year","amount":15000}` → "₹15,000 per year";
 * `{"day":30,"month":11}` → "30 November"; `18` under a `…rate…` key → "18%"; `14` under a
 * `…_days` key → "14 days". Rupees in lakh and crore, other numbers in Indian grouping. `key` is the
 * parameter's key (it names the unit of a plain number). Cut at `max` characters (the full JSON is
 * in the editor).
 */
export function describeParameterValue(value: unknown, max = 90, key?: string): string {
  // A whole table (a year's income-tax rule set) doesn't fit a cell: say so instead of printing its first line.
  if (value !== null && typeof value === "object" && JSON.stringify(value).length > 600) return "A detailed table (open it under ⋯ → Change from a date)";
  const text = describePart(value, key?.split(".").pop());
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A parameter's note split for the table: the meaning, and what a Partner still has to check (the
 * text after "[verify]"). References to the specification ("(§6.5)") are for developers and are
 * dropped.
 */
export function splitParameterNote(note: string | null | undefined): { meaning: string; toCheck: string | null } {
  const clean = (note ?? "")
    .replace(/\s*\((?:§\s*[\d.]+(?:\s*,\s*|\s+and\s+)?)+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const at = clean.indexOf("[verify]");
  if (at < 0) return { meaning: clean, toCheck: null };
  const tidy = (t: string) => t.trim().replace(/^[\s:;,.-]+/, "");
  const after = tidy(clean.slice(at + "[verify]".length));
  return { meaning: clean.slice(0, at).trim(), toCheck: after ? after.charAt(0).toUpperCase() + after.slice(1) : null };
}

const parameterValueText = z
  .string({ error: "Enter the value." })
  .superRefine((v, ctx) => {
    const r = parseParameterValue(v);
    if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
  })
  .transform((v) => (parseParameterValue(v) as { ok: true; value: unknown }).value);

const dateField = (label: string) =>
  z.string({ error: `Choose ${label}.` }).refine((v) => isDateString(v), { error: `Choose ${label}.` });

const optionalDate = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isDateString(v), { error: "Choose a date." });

/** `gst.default_rate_services`: lower-case words joined by dots, at least two parts. */
export const PARAMETER_KEY_PATTERN = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;

const sourceRefRequired = z
  .string({ error: "Name the source: the Finance Act, notification or circular, with its date." })
  .trim()
  .min(4, { error: "Name the source: the Finance Act, notification or circular, with its date." })
  .max(300, { error: "Use 300 characters or fewer." });

// -------------------------------------------------------------------------------------------------
// Statutory parameters
// -------------------------------------------------------------------------------------------------

/** A change from a date: closes the row in force the day before and adds a new row (§5.12). */
export const ParameterChangeSchema = z.object({
  id: z.uuid({ error: "Reload the page and try again." }),
  updated_at: concurrencyToken,
  effective_from: dateField("the date the change takes effect"),
  value: parameterValueText,
  statute: optionalText(120),
  section_ref: optionalText(120),
  source_ref: sourceRefRequired,
  notes: optionalText(1000),
  /** The Partner checked the value against the source: the new row is saved as verified. */
  verified: z.boolean().default(true),
});
export type ParameterChangeInput = z.input<typeof ParameterChangeSchema>;

export const ParameterAddSchema = z
  .object({
    key: z
      .string({ error: "Enter the key." })
      .trim()
      .toLowerCase()
      .regex(PARAMETER_KEY_PATTERN, { error: "Use lower-case words joined by dots, like tds.professional_fees.rate." })
      .max(120, { error: "Use 120 characters or fewer." }),
    value: parameterValueText,
    effective_from: dateField("the date it takes effect"),
    effective_to: optionalDate,
    statute: optionalText(120),
    section_ref: optionalText(120),
    source_ref: sourceRefRequired,
    notes: optionalText(1000),
    verified: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (d.effective_to && compareDates(d.effective_to, d.effective_from) < 0) {
      ctx.addIssue({ code: "custom", path: ["effective_to"], message: "The end date is before the start date." });
    }
  });
export type ParameterAddInput = z.input<typeof ParameterAddSchema>;

// -------------------------------------------------------------------------------------------------
// Verification and review
// -------------------------------------------------------------------------------------------------

export const VERIFIABLE_TABLES = ["statutory_parameters", "due_date_rules", "section_concordance"] as const;
export type VerifiableTable = (typeof VERIFIABLE_TABLES)[number];

export const MarkVerifiedSchema = z.object({
  table: z.enum(VERIFIABLE_TABLES),
  id: z.uuid({ error: "Reload the page and try again." }),
  updated_at: concurrencyToken,
});
export type MarkVerifiedInput = z.input<typeof MarkVerifiedSchema>;

/** Several rows of one table confirmed together (a Partner who has checked a group against one source). */
export const MarkVerifiedManySchema = z.object({
  table: z.enum(VERIFIABLE_TABLES),
  items: z
    .array(z.object({ id: z.uuid({ error: "Reload the page and try again." }), updated_at: concurrencyToken }))
    .min(1, { error: "Tick the rows to confirm." })
    .max(100, { error: "Confirm at most 100 rows at a time." }),
});
export type MarkVerifiedManyInput = z.input<typeof MarkVerifiedManySchema>;

export const MarkReviewedSchema = z.object({
  note: optionalText(300),
});
export type MarkReviewedInput = z.input<typeof MarkReviewedSchema>;

// -------------------------------------------------------------------------------------------------
// Due-date rules
// -------------------------------------------------------------------------------------------------

/** `GSTR3B_MONTHLY`: upper-case letters, digits and underscores. */
export const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

function jsonText(label: string) {
  return z.string({ error: `Enter the ${label}.` }).transform((v, ctx) => {
    const t = v.trim();
    if (t === "") return {};
    try {
      return JSON.parse(t) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: `The ${label} isn't valid JSON. Check the brackets, quotes and commas.` });
      return z.NEVER;
    }
  });
}

/**
 * A rule change from a date (§5.12). `due_date_rules.code` is unique, so the new version gets its
 * own code (the generator picks whichever version is in force for a period); the old row is closed
 * the day before.
 */
export const DueDateRuleChangeSchema = z
  .object({
    id: z.uuid({ error: "Reload the page and try again." }),
    updated_at: concurrencyToken,
    effective_from: dateField("the date the change takes effect"),
    new_code: z
      .string({ error: "Enter a code for the new version." })
      .trim()
      .toUpperCase()
      .regex(RULE_CODE_PATTERN, { error: "Use upper-case letters, digits and underscores, like GSTR3B_MONTHLY_2027." }),
    title: z.string({ error: "Enter the title." }).trim().min(3, { error: "Enter the title." }).max(160, { error: "Use 160 characters or fewer." }),
    form_code: optionalText(40),
    frequency: z.enum(SERVICE_FREQUENCIES),
    rule: jsonText("rule"),
    applies_to: jsonText("applies-to filter"),
    reminder_days: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .pipe(z.string().regex(/^\d{1,3}$/, { error: "Enter the reminder days as a whole number." }))
      .transform(Number)
      .pipe(z.number().int().min(0).max(365, { error: "Reminder days can be at most 365." })),
    source_ref: sourceRefRequired,
    verified: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    const spec = parseRuleSpec(d.rule, d.frequency as ServiceFrequency);
    if (!spec.ok) ctx.addIssue({ code: "custom", path: ["rule"], message: spec.error });
    const applies = parseAppliesTo(d.applies_to);
    if (!applies.ok) ctx.addIssue({ code: "custom", path: ["applies_to"], message: applies.error });
  });
export type DueDateRuleChangeInput = z.input<typeof DueDateRuleChangeSchema>;

/** A suggested code for a new version: `GSTR3B_MONTHLY` from 2027-04-01 → `GSTR3B_MONTHLY_2027`. */
export function suggestVersionCode(code: string, effectiveFrom: string, existing: ReadonlySet<string> = new Set()): string {
  const base = code.replace(/_(?:19|20)\d{2}(?:_\d+)?$/, "");
  const year = /^\d{4}/.exec(effectiveFrom)?.[0] ?? "NEW";
  let candidate = `${base}_${year}`.slice(0, 64);
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base}_${year}_${n}`.slice(0, 64);
    n += 1;
  }
  return candidate;
}

// -------------------------------------------------------------------------------------------------
// Government extensions (due_date_overrides)
// -------------------------------------------------------------------------------------------------

export const OverrideSchema = z
  .object({
    rule_code: z.string({ error: "Choose the rule." }).trim().min(1, { error: "Choose the rule." }),
    period_label: z
      .string({ error: "Enter the period exactly as the events show it." })
      .trim()
      .min(3, { error: "Enter the period exactly as the events show it, like Sep 2026 or AY 2026-27." })
      .max(40, { error: "Use 40 characters or fewer." }),
    original_due: dateField("the original due date"),
    extended_due: dateField("the extended due date"),
    scope: optionalText(300),
    source_ref: sourceRefRequired,
  })
  .superRefine((d, ctx) => {
    if (isDateString(d.original_due) && isDateString(d.extended_due) && compareDates(d.extended_due, d.original_due) <= 0) {
      ctx.addIssue({ code: "custom", path: ["extended_due"], message: "An extension moves the date later. Choose a date after the original." });
    }
  });
export type OverrideInput = z.input<typeof OverrideSchema>;

// -------------------------------------------------------------------------------------------------
// Section concordance (1961 Act ↔ 2025 Act)
// -------------------------------------------------------------------------------------------------

export const ConcordanceSchema = z
  .object({
    id: z.uuid().nullish().transform((v) => v ?? null),
    updated_at: z.string().nullish().transform((v) => v || null),
    topic: z.string({ error: "Enter the topic." }).trim().min(2, { error: "Enter the topic." }).max(160, { error: "Use 160 characters or fewer." }),
    old_section: optionalText(60),
    new_section: optionalText(60),
    old_form: optionalText(60),
    new_form: optionalText(60),
    source_ref: optionalText(300),
    /** Checked against the CBDT's published mapping (§6.1). Unchecked rows show as awaiting confirmation. */
    verified: z.boolean().default(false),
  })
  .superRefine((d, ctx) => {
    if (!d.old_section && !d.new_section && !d.old_form && !d.new_form) {
      ctx.addIssue({ code: "custom", path: ["new_section"], message: "Enter at least one section or form." });
    }
    if (d.id && !d.updated_at) ctx.addIssue({ code: "custom", path: ["topic"], message: "Reload the page and try again." });
  });
export type ConcordanceInput = z.input<typeof ConcordanceSchema>;

// -------------------------------------------------------------------------------------------------
// Effective dating (pure)
// -------------------------------------------------------------------------------------------------

/**
 * Where a change from `newFrom` can go for a row in force from `rowFrom` (to `rowTo`): it must start
 * after the row starts, and not after the row has already ended. Returns the closing date for the
 * old row (the day before), or the reason it can't.
 */
export function planSupersede(
  row: { effective_from: DateString; effective_to: DateString | null },
  newFrom: DateString,
): { ok: true; closeOldOn: DateString } | { ok: false; error: string } {
  if (!isDateString(newFrom)) return { ok: false, error: "Choose the date the change takes effect." };
  if (compareDates(newFrom, row.effective_from) <= 0) {
    return {
      ok: false,
      error: `The change must start after ${formatDate(row.effective_from)}, the date the current row took effect. History is never overwritten, so a change always starts on a later date.`,
    };
  }
  if (row.effective_to && compareDates(newFrom, addDays(row.effective_to, 1)) > 0) {
    return { ok: false, error: "This row has already ended. Change the row in force on that date instead." };
  }
  return { ok: true, closeOldOn: addDays(newFrom, -1) };
}

/** Compliance types and frequencies for the rule editor's selects. */
export const RULE_COMPLIANCE_TYPES = COMPLIANCE_TYPES;
export const RULE_FREQUENCIES = SERVICE_FREQUENCIES;
