import { z } from "zod";
import { COMPLIANCE_TYPES, COMPLIANCE_WORKFLOWS, SERVICE_TYPES, type ComplianceType } from "@/lib/domain/enums";
import { compareDates, isDateString, isFinancialYear, type DateString } from "@/lib/domain/fy";

/**
 * Compliance (§7.7, §7.6.5, §5.6): the shapes shared by the forms (client) and
 * server/actions/compliance.ts (server), plus the return types of the filings grid. Client-safe.
 *
 *   EventFormSchema       add / edit a deadline (§7.7 "Event form")
 *   WorkflowChangeSchema  Not started → Documents awaited → In progress → Under review → Filed → Completed
 *   FilingSchema          the §7.6.5 details captured when a deadline is filed
 *   CancelEventSchema     cancel (with a reason) or restore
 *   GenerateSchema        "Generate deadlines" for one client; GenerateManySchema for the coverage-gaps fix
 *   ReportRangeSchema     the client compliance report's date range
 */

export const COMPLIANCE_LIMITS = {
  title: 200,
  formCode: 40,
  period: 40,
  description: 2000,
  notes: 2000,
  reason: 500,
  acknowledgement: 60,
  filingType: 60,
  reminderDaysMax: 90,
  /** Report range: at most this many days (about three years). */
  reportDaysMax: 1100,
  /** Clients fixed in one "Generate deadlines for all" (coverage gaps). */
  generateManyMax: 200,
} as const;

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, { error: tooLong })
    .nullish()
    .transform((v) => (v ? v : null));

const requiredDate = (missing: string) =>
  z
    .string({ error: missing })
    .trim()
    .refine((v) => v.length > 0, { error: missing })
    .refine((v) => v.length === 0 || isDateString(v), { error: "Enter a real date." });

const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isDateString(v), { error: "Enter a real date." });

const optionalFy = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isFinancialYear(v), { error: "Enter the financial year as YYYY-YY, for example 2026-27." });

/** A select's "nothing chosen" value (Radix selects can't hold an empty string). */
export const NONE = "none";

/** An optional id from a select: "", "none" (nothing chosen) and null read as null. */
const optionalId = (what: string) =>
  z
    .union([z.literal(""), z.literal(NONE), uuid(what)])
    .nullish()
    .transform((v) => (v && v !== NONE ? v : null));

/** `updated_at` as loaded, for optimistic concurrency (§13). */
const expectedUpdatedAt = z.string().trim().min(1).nullish().transform((v) => v ?? null);

// -------------------------------------------------------------------------------------------------
// The event form (§7.7)
// -------------------------------------------------------------------------------------------------

export const EventFormSchema = z
  .object({
    id: optionalId("deadline"),
    expectedUpdatedAt,
    /** Null = a firm-level event (Partners and Managers only, 0037). */
    clientId: optionalId("client"),
    type: z.enum(COMPLIANCE_TYPES, { error: "Choose the type of deadline." }),
    formCode: optionalText(COMPLIANCE_LIMITS.formCode, `Keep the form code under ${COMPLIANCE_LIMITS.formCode} characters.`),
    title: z
      .string()
      .trim()
      .min(1, { error: "Enter a title, for example “GSTR-3B for Sep 2026”." })
      .max(COMPLIANCE_LIMITS.title, { error: `Keep the title under ${COMPLIANCE_LIMITS.title} characters.` }),
    description: optionalText(COMPLIANCE_LIMITS.description, "Keep the description shorter."),
    financialYear: optionalFy,
    filingPeriod: optionalText(COMPLIANCE_LIMITS.period, "Keep the period short, for example “Sep 2026” or “Q2 2026-27”."),
    dueDate: requiredDate("Enter the due date."),
    reminderDays: z.coerce
      .number({ error: "Enter the number of days." })
      .int({ error: "Use whole days." })
      .min(0, { error: "Use 0 or more days." })
      .max(COMPLIANCE_LIMITS.reminderDaysMax, { error: `At most ${COMPLIANCE_LIMITS.reminderDaysMax} days before.` }),
    /** Statutory deadlines show in the client's portal (§7.22); firm and internal steps don't. */
    isStatutory: z.boolean().default(true),
    /** §7.7 "Linked task (create one automatically: toggle)". New client deadlines only. */
    createTask: z.boolean().default(false),
    notes: optionalText(COMPLIANCE_LIMITS.notes, "Keep the notes shorter."),
    /** ROC: the AGM date entered on the client's AGM event fixes the ADT-1 / AOC-4 / MGT-7 dates (§6.7). */
    agmDate: optionalDate,
  })
  .superRefine((v, ctx) => {
    if (v.createTask && !v.clientId) {
      ctx.addIssue({ code: "custom", path: ["createTask"], message: "A task needs a client. Choose the client, or turn this off for a firm-level deadline." });
    }
  });
export type EventFormInput = z.input<typeof EventFormSchema>;
export type EventFormValues = z.output<typeof EventFormSchema>;

// -------------------------------------------------------------------------------------------------
// Workflow, filing, cancel
// -------------------------------------------------------------------------------------------------

export const WorkflowChangeSchema = z.object({
  eventId: uuid("deadline"),
  to: z.enum(COMPLIANCE_WORKFLOWS, { error: "Choose where it moves to." }),
  reason: optionalText(COMPLIANCE_LIMITS.reason, `Keep the reason under ${COMPLIANCE_LIMITS.reason} characters.`),
  expectedUpdatedAt,
});
export type WorkflowChangeInput = z.input<typeof WorkflowChangeSchema>;

export const FilingSchema = z
  .object({
    eventId: uuid("deadline"),
    expectedUpdatedAt,
    /** Link a filing record that already exists instead of entering one. */
    filingRecordId: optionalId("filing record"),
    filingType: optionalText(COMPLIANCE_LIMITS.filingType, `Keep the form under ${COMPLIANCE_LIMITS.filingType} characters.`),
    period: optionalText(COMPLIANCE_LIMITS.period, "Keep the period short, for example “Sep 2026”."),
    financialYear: optionalFy,
    filedOn: optionalDate,
    acknowledgementNo: z
      .string()
      .trim()
      .max(COMPLIANCE_LIMITS.acknowledgement, { error: `Keep it under ${COMPLIANCE_LIMITS.acknowledgement} characters.` })
      .nullish()
      .transform((v) => (v ? v.replace(/\s+/g, "").toUpperCase() : null)),
    serviceType: z.union([z.literal(""), z.enum(SERVICE_TYPES)]).nullish().transform((v) => (v ? v : null)),
    documentId: optionalId("acknowledgement"),
    udinRecordId: optionalId("UDIN"),
    notes: optionalText(COMPLIANCE_LIMITS.notes, "Keep the notes shorter."),
    shareableWithClient: z.boolean().default(true),
    /** Mark the deadline Completed (closed) rather than Filed. */
    complete: z.boolean().default(false),
    /** "Today" in IST, from the server; the form passes it so the future-date check matches. */
    today: z.string().nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.filingRecordId) return;
    if (!v.filingType) ctx.addIssue({ code: "custom", path: ["filingType"], message: "Enter the return or form that was filed, for example GSTR-3B." });
    if (!v.period) ctx.addIssue({ code: "custom", path: ["period"], message: "Enter the period it is for, for example Sep 2026." });
    if (!v.financialYear) ctx.addIssue({ code: "custom", path: ["financialYear"], message: "Enter the financial year, for example 2026-27." });
    if (!v.filedOn) ctx.addIssue({ code: "custom", path: ["filedOn"], message: "Enter the date it was filed." });
    else if (v.today && isDateString(v.today) && compareDates(v.filedOn, v.today) > 0) {
      ctx.addIssue({ code: "custom", path: ["filedOn"], message: "The filed-on date can't be in the future." });
    }
  });
export type FilingInput = z.input<typeof FilingSchema>;
export type FilingValues = z.output<typeof FilingSchema>;

export const CancelEventSchema = z
  .object({
    eventId: uuid("deadline"),
    /** false = cancel (reason required), true = restore a cancelled deadline. */
    restore: z.boolean().default(false),
    reason: optionalText(COMPLIANCE_LIMITS.reason, `Keep the reason under ${COMPLIANCE_LIMITS.reason} characters.`),
    expectedUpdatedAt,
  })
  .superRefine((v, ctx) => {
    if (!v.restore && !v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Say why it is no longer needed, for example “GST registration cancelled”." });
  });
export type CancelEventInput = z.input<typeof CancelEventSchema>;

export const NotesSchema = z.object({
  eventId: uuid("deadline"),
  notes: optionalText(COMPLIANCE_LIMITS.notes, "Keep the notes shorter."),
  expectedUpdatedAt,
});

export const GenerateSchema = z.object({ clientId: uuid("client") });
export type GenerateInput = z.input<typeof GenerateSchema>;

export const GenerateManySchema = z.object({
  clientIds: z
    .array(uuid("client"))
    .min(1, { error: "Choose at least one client." })
    .max(COMPLIANCE_LIMITS.generateManyMax, { error: `At most ${COMPLIANCE_LIMITS.generateManyMax} clients at a time.` })
    .transform((ids) => [...new Set(ids)]),
});

export const ReportRangeSchema = z
  .object({
    from: requiredDate("Choose the first date."),
    to: requiredDate("Choose the last date."),
  })
  .superRefine((v, ctx) => {
    if (!isDateString(v.from) || !isDateString(v.to)) return;
    if (compareDates(v.to, v.from) < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "The last date is before the first." });
    const days = (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000;
    if (days > COMPLIANCE_LIMITS.reportDaysMax) ctx.addIssue({ code: "custom", path: ["to"], message: "Choose at most three years." });
  });

// -------------------------------------------------------------------------------------------------
// The filings grid's return types (§7.7: "Filter by return type (GSTR-1, GSTR-3B, TDS return, ITR, ROC…)")
// -------------------------------------------------------------------------------------------------

/** Columns: the FY's months (a quarterly return spans its three), its quarters, or one per form. */
export type GridLayout = "month" | "quarter" | "form";

export type ReturnTypeGroup = "GST" | "Income tax" | "TDS" | "ROC" | "Payroll";

export interface GridReturnType {
  key: string;
  label: string;
  group: ReturnTypeGroup;
  types: readonly ComplianceType[];
  /**
   * Case-insensitive regular expression on `form_code` (and `rulePattern` on `rule_code`). Plain
   * syntax that Postgres (`~*`) and JavaScript read the same way. Both null = every event of `types`.
   */
  formPattern: string | null;
  rulePattern: string | null;
  layout: GridLayout;
  /** One line under the grid title. */
  description: string;
}

export const GRID_RETURN_TYPES: readonly GridReturnType[] = [
  { key: "gstr_3b", label: "GSTR-3B", group: "GST", types: ["gstr_3b"], formPattern: "^GSTR-3B$", rulePattern: null, layout: "month", description: "Monthly returns by the 20th; QRMP quarters by the 22nd or 24th." },
  { key: "gstr_1", label: "GSTR-1", group: "GST", types: ["gstr_1"], formPattern: "^GSTR-1$", rulePattern: null, layout: "month", description: "Monthly returns by the 11th; QRMP quarters by the 13th." },
  { key: "iff", label: "IFF", group: "GST", types: ["gstr_1"], formPattern: "^IFF$", rulePattern: null, layout: "month", description: "Invoice Furnishing Facility for months 1 and 2 of a QRMP quarter, by the 13th." },
  { key: "pmt_06", label: "PMT-06", group: "GST", types: ["gstr_3b"], formPattern: "^PMT-06$", rulePattern: null, layout: "month", description: "QRMP tax payment for months 1 and 2 of the quarter, by the 25th." },
  { key: "cmp_08", label: "CMP-08", group: "GST", types: ["gstr_3b"], formPattern: "^CMP-08$", rulePattern: null, layout: "quarter", description: "Composition statement, by the 18th after the quarter." },
  { key: "gst_tds_tcs", label: "GSTR-7 / GSTR-8", group: "GST", types: ["custom"], formPattern: "^GSTR-(7|8)$", rulePattern: null, layout: "month", description: "TDS and TCS returns under GST, by the 10th." },
  { key: "gst_annual", label: "GST annual returns", group: "GST", types: ["custom"], formPattern: "^(GSTR-9|GSTR-9C|GSTR-4)$", rulePattern: null, layout: "form", description: "GSTR-9, GSTR-9C and GSTR-4 for the financial year." },
  { key: "itr", label: "ITR", group: "Income tax", types: ["itr"], formPattern: "^ITR", rulePattern: null, layout: "form", description: "Returns of income for the year, with belated, revised and updated returns where they apply." },
  { key: "tax_audit", label: "Tax audit report", group: "Income tax", types: ["audit"], formPattern: "^(Form 3CA/3CB-3CD|Form 26|Form 3CEB)$", rulePattern: null, layout: "form", description: "Tax audit and transfer-pricing reports for the year." },
  { key: "advance_tax", label: "Advance tax", group: "Income tax", types: ["advance_tax"], formPattern: null, rulePattern: null, layout: "quarter", description: "Instalments on 15 June, 15 September, 15 December and 15 March." },
  { key: "tds_deposit", label: "TDS/TCS deposit", group: "TDS", types: ["tds"], formPattern: "^TDS deposit$", rulePattern: null, layout: "month", description: "Tax deducted in a month, deposited by the 7th (March by 30 April)." },
  { key: "tds_return", label: "TDS return", group: "TDS", types: ["tds"], formPattern: "(24Q|26Q|27Q|27EQ|Form 138|Form 140|Form 143|Form 144)", rulePattern: "^TDS_RETURN", layout: "quarter", description: "Quarterly statements: Q1 31 July, Q2 31 October, Q3 31 January, Q4 31 May." },
  { key: "form_16a", label: "Form 16A", group: "TDS", types: ["tds"], formPattern: "^(Form 16A|Form 131)$", rulePattern: null, layout: "quarter", description: "Non-salary TDS certificates, 15 days after each statement is due." },
  { key: "roc", label: "ROC", group: "ROC", types: ["roc"], formPattern: null, rulePattern: null, layout: "form", description: "AGM, ADT-1, AOC-4, MGT-7, DPT-3, MSME-1, DIR-3 KYC and LLP forms for the year." },
  { key: "pf_esic", label: "PF/ESIC", group: "Payroll", types: ["pf_esic"], formPattern: null, rulePattern: null, layout: "month", description: "Contributions by the 15th of the next month." },
  { key: "pt", label: "Professional tax", group: "Payroll", types: ["pt"], formPattern: "^PT( \\(|$)", rulePattern: null, layout: "month", description: "Employer remittance by the 20th of the next month." },
];

export const DEFAULT_RETURN_TYPE = "gstr_3b";

export function returnTypeByKey(key: string | null | undefined): GridReturnType {
  return GRID_RETURN_TYPES.find((t) => t.key === key) ?? GRID_RETURN_TYPES.find((t) => t.key === DEFAULT_RETURN_TYPE)!;
}

/** True when an event belongs to a return type (the same test filings_grid runs in SQL). */
export function matchesReturnType(event: { type: string; form_code: string | null; rule_code?: string | null }, rt: GridReturnType): boolean {
  if (!(rt.types as readonly string[]).includes(event.type)) return false;
  if (rt.formPattern === null && rt.rulePattern === null) return true;
  if (rt.formPattern !== null && new RegExp(rt.formPattern, "i").test(event.form_code ?? "")) return true;
  return rt.rulePattern !== null && new RegExp(rt.rulePattern, "i").test(event.rule_code ?? "");
}

/** The grid's status filter: clients with an overdue cell, or with anything not yet filed. */
export const GRID_STATUS_FILTERS = ["overdue", "unfiled"] as const;
export type GridStatusFilter = (typeof GRID_STATUS_FILTERS)[number];
export const GRID_STATUS_LABELS: Record<GridStatusFilter, string> = {
  overdue: "Has an overdue return",
  unfiled: "Has a return not yet filed",
};

/** Owner filter value for clients with no owner. */
export const UNASSIGNED = "none";

export type DateRange = { from: DateString; to: DateString };
