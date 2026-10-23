import { z } from "zod";
import { compareDates, financialYearOf, fyEnd, fyStart, isDateString, isFinancialYear, todayIST, type DateString } from "@/lib/domain/fy";
import { HANDOFF_CHANNELS } from "@/lib/handoff";
import { TDS_CREDIT_STATUSES } from "@/lib/domain/collections";

/**
 * Collections (§7.9.5, §7.9.6, §7.9.9, §7.9.10): the inputs of the collections, retainer and TDS
 * credit actions (one zod schema shared by forms and actions, CONVENTIONS §5), and the filters and
 * sorts of the pages. Client-safe; no I/O.
 */

export const COLLECTIONS_LIMITS = {
  notes: 2000,
  reason: 500,
  claimedIn: 200,
  /** A 26AS / AIS text or CSV export (server actions accept about 1 MB). */
  statementBytes: 900_000,
  fileName: 200,
} as const;

const uuid = (what: string) => z.uuid({ error: `Choose the ${what}.` });

const dateOnly = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => isDateString(v), { error: message });

const optionalDate = (message: string) =>
  z
    .union([z.literal(""), z.null(), z.undefined(), dateOnly(message)])
    .transform((v) => (v ? v : null));

// -------------------------------------------------------------------------------------------------
// Follow-ups (§7.9.5 "Follow-up log per invoice: channel, notes*, promised payment date, next follow-up")
// -------------------------------------------------------------------------------------------------

export const FOLLOW_UP_CHANNELS = ["call", "email", "whatsapp", "visit", "other"] as const;
export type FollowUpChannel = (typeof FOLLOW_UP_CHANNELS)[number];

export const FOLLOW_UP_CHANNEL_LABEL: Record<FollowUpChannel, string> = {
  call: "Call",
  email: "Email",
  whatsapp: "WhatsApp",
  visit: "Visit",
  other: "Other",
};

/** The hour (IST) a "next follow-up" date is set for. */
export const FOLLOW_UP_HOUR_IST = "10:00";

export const FollowUpSchema = z
  .object({
    invoiceId: uuid("invoice"),
    channel: z.enum(FOLLOW_UP_CHANNELS, { error: "Choose how you reached the client." }),
    notes: z.string().trim().min(1, { error: "Write what was said or agreed." }).max(COLLECTIONS_LIMITS.notes, { error: `Keep the notes under ${COLLECTIONS_LIMITS.notes.toLocaleString("en-IN")} characters.` }),
    promisedPaymentDate: optionalDate("Enter the date they promised to pay."),
    nextFollowUpOn: optionalDate("Enter the date of the next follow-up."),
  })
  .superRefine((v, ctx) => {
    const today = todayIST();
    if (v.promisedPaymentDate && compareDates(v.promisedPaymentDate, today) < 0) {
      ctx.addIssue({ code: "custom", path: ["promisedPaymentDate"], message: "A promised date is today or later. Log a missed promise in the notes." });
    }
    if (v.nextFollowUpOn && compareDates(v.nextFollowUpOn, today) < 0) {
      ctx.addIssue({ code: "custom", path: ["nextFollowUpOn"], message: "The next follow-up is today or later." });
    }
  });
export type FollowUpInput = z.input<typeof FollowUpSchema>;

/** `2026-10-25` → the timestamptz of 10:00 IST that day. */
export function followUpTimestamp(date: DateString): string {
  return `${date}T${FOLLOW_UP_HOUR_IST}:00+05:30`;
}

// -------------------------------------------------------------------------------------------------
// Reminder hand-offs (§7.9.5 "otherwise surfaced to the owner as hand-off tasks")
// -------------------------------------------------------------------------------------------------

export const ReminderHandoffSchema = z.object({
  reminderId: uuid("reminder"),
  channel: z.enum(HANDOFF_CHANNELS),
  contactId: z
    .union([z.uuid(), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  recipient: z.string().trim().min(1, { error: "There's no recipient." }).max(320),
  subject: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => (v ? v : null)),
  body: z.string().trim().min(1, { error: "The message is empty." }).max(10_000),
  templateId: z
    .union([z.uuid(), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
});
export type ReminderHandoffInput = z.input<typeof ReminderHandoffSchema>;

export const DismissReminderSchema = z.object({
  reminderId: uuid("reminder"),
  reason: z.string().trim().min(1, { error: "Say why this reminder isn't needed." }).max(COLLECTIONS_LIMITS.reason),
});
export type DismissReminderInput = z.input<typeof DismissReminderSchema>;

// -------------------------------------------------------------------------------------------------
// Retainer drafts (§7.9.6)
// -------------------------------------------------------------------------------------------------

export const SubmitDraftsSchema = z.object({
  items: z
    .array(z.object({ invoiceId: uuid("draft"), updatedAt: z.string().min(1) }))
    .min(1, { error: "Select at least one draft." })
    .max(200, { error: "Send at most 200 drafts at a time." }),
});
export type SubmitDraftsInput = z.input<typeof SubmitDraftsSchema>;

export const RETAINER_QUEUE_SORTABLE = ["client_name", "period", "billing_date", "total_amount", "run_date"] as const;
export const RETAINER_QUEUE_FILTERS = { state: ["waiting", "held", "issued", "all"], run: null } as const;
export type RetainerQueueState = (typeof RETAINER_QUEUE_FILTERS.state)[number];

export const RETAINER_STATE_LABEL: Record<RetainerQueueState, string> = {
  waiting: "Waiting to issue",
  held: "Held for a Partner",
  issued: "Issued",
  all: "All",
};

// -------------------------------------------------------------------------------------------------
// TDS credits (§7.9.9)
// -------------------------------------------------------------------------------------------------

export const TdsStatusSchema = z
  .object({
    items: z.array(z.object({ id: uuid("credit"), updatedAt: z.string().min(1) })).min(1, { error: "Select at least one TDS credit." }).max(500, { error: "Mark at most 500 credits at a time." }),
    status: z.enum(TDS_CREDIT_STATUSES),
    on: optionalDate("Enter a valid date."),
    note: z
      .string()
      .trim()
      .max(COLLECTIONS_LIMITS.reason)
      .nullish()
      .transform((v) => (v ? v : null)),
    claimedIn: z
      .string()
      .trim()
      .max(COLLECTIONS_LIMITS.claimedIn)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.status === "claimed" && !v.claimedIn) ctx.addIssue({ code: "custom", path: ["claimedIn"], message: "Say where the credit was claimed, for example ITR for tax year 2026-27." });
    if (v.on && compareDates(v.on, todayIST()) > 0) ctx.addIssue({ code: "custom", path: ["on"], message: "The date can't be in the future." });
  });
export type TdsStatusInput = z.input<typeof TdsStatusSchema>;

export const TDS_SOURCES = ["26as", "ais", "form_168"] as const;
export type TdsSource = (typeof TDS_SOURCES)[number];
export const TDS_SOURCE_LABEL: Record<TdsSource, string> = { "26as": "Form 26AS", ais: "AIS", form_168: "Form 168 (2025 Act)" };

export const TdsImportSchema = z.object({
  fileName: z.string().trim().max(COLLECTIONS_LIMITS.fileName).optional().default(""),
  text: z
    .string()
    .min(1, { error: "Choose the 26AS or AIS file." })
    .max(COLLECTIONS_LIMITS.statementBytes, { error: "The file is too large. Export one financial year at a time." }),
  source: z.enum(TDS_SOURCES),
  financialYear: z.string().refine((v) => isFinancialYear(v), { error: "Choose the financial year the statement is for." }),
});
export type TdsImportInput = z.input<typeof TdsImportSchema>;

export const DeductorTanSchema = z.object({
  receiptId: uuid("receipt"),
  tan: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
    .refine((v) => /^[A-Z]{4}[0-9]{5}[A-Z]$/.test(v), { error: "Enter the TAN as 4 letters, 5 digits and a letter, for example BLRA12345B." }),
  updatedAt: z.string().min(1),
});
export type DeductorTanInput = z.input<typeof DeductorTanSchema>;

export const TdsEntryStatusSchema = z
  .object({
    entryId: uuid("statement line"),
    status: z.enum(["ignored", "unmatched"]),
    note: z
      .string()
      .trim()
      .max(COLLECTIONS_LIMITS.reason)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.status === "ignored" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Say why this line is being set aside." });
  });
export type TdsEntryStatusInput = z.input<typeof TdsEntryStatusSchema>;

export const TDS_CREDIT_SORTABLE = ["payment_date", "client_name", "tds_amount", "quarter", "invoice_number"] as const;
export const TDS_CREDIT_FILTERS = { status: TDS_CREDIT_STATUSES, quarter: null, tan: ["missing"] } as const;

// -------------------------------------------------------------------------------------------------
// Periods for reports, statements and exports
// -------------------------------------------------------------------------------------------------

/** A from/to date range; to on or after from, not more than 5 years long. */
export const DateRangeSchema = z
  .object({
    from: dateOnly("Enter the from date."),
    to: dateOnly("Enter the to date."),
  })
  .superRefine((v, ctx) => {
    if (isDateString(v.from) && isDateString(v.to) && compareDates(v.from, v.to) > 0) ctx.addIssue({ code: "custom", path: ["to"], message: "The to date is on or after the from date." });
    if (isDateString(v.from) && isDateString(v.to) && Number(v.to.slice(0, 4)) - Number(v.from.slice(0, 4)) > 5) ctx.addIssue({ code: "custom", path: ["from"], message: "Choose a period of at most 5 years." });
  });

/** The FY range for an FY label, clipped to today (for "so far" reports). */
export function fyRange(fy: string, today: DateString = todayIST()): { from: DateString; to: DateString } {
  const from = fyStart(fy);
  const end = fyEnd(fy);
  return { from, to: compareDates(end, today) > 0 && compareDates(from, today) <= 0 ? today : end };
}

/** The statement's period from the request, defaulting to the FY so far. */
export function statementRange(params: { from?: string | null; to?: string | null }, today: DateString = todayIST()): { from: DateString; to: DateString } | { error: string } {
  const fallback = fyRange(financialYearOf(today), today);
  const parsed = DateRangeSchema.safeParse({ from: params.from || fallback.from, to: params.to || fallback.to });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose a valid period." };
  return parsed.data;
}

export const REVENUE_KINDS = ["invoices", "receipts", "credit_notes"] as const;
export type RevenueKind = (typeof REVENUE_KINDS)[number];
export const REVENUE_KIND_LABEL: Record<RevenueKind, string> = { invoices: "Invoices", receipts: "Receipts", credit_notes: "Credit notes" };
export const REVENUE_SORTABLE: Record<RevenueKind, readonly string[]> = {
  invoices: ["date", "number", "client", "taxable_amount", "gst_amount", "total_amount", "received", "outstanding_amount"],
  receipts: ["date", "number", "client", "amount_received", "tds_amount"],
  credit_notes: ["date", "number", "client", "taxable_amount", "total_amount"],
};
