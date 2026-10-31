import { z } from "zod";
import {
  QUOTATION_STATUSES,
  SERVICE_FREQUENCIES,
  SERVICE_FREQUENCY_LABELS,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  type AppRole,
  type QuotationStatus,
  type ServiceFrequency,
  type ServiceType,
} from "@/lib/domain/enums";
import { addDays, compareDates, isDateString, type DateString } from "@/lib/domain/fy";
import { computeLine, isIntraState, splitTax, FIRM_STATE_CODE_DEFAULT } from "@/lib/domain/gst";
import { amountInWords, parseAmount, sumPaise, toPaise, type Paise } from "@/lib/domain/money";
import { deriveFromGstin, isValidStateCode, stateName, validateGstin } from "@/lib/domain/india-validators";
import { quotationNeedsApproval } from "@/lib/domain/approvals";
import { isPlausiblePhone } from "@/lib/schemas/leads";

/**
 * Quotations (§7.5.2 builder, §7.5.3 sending and tracking, §7.23 the public page): the builder's
 * schema, the send / approval / hand-off inputs, and the pure rules the pages, the PDF, the public
 * page and the jobs share (totals and the tax split, which actions a quotation offers, what the
 * client's link shows, which follow-up is due). Client-safe.
 *
 * Money: every amount is integer paise in TypeScript (lib/domain/money); a line's amount is
 * round(qty × unit price) and its GST round(amount × rate%), half-up to the paisa, exactly as
 * quotation_items_guard (0143) computes them. The CGST/SGST split is per line (lib/domain/gst.ts
 * splitTax), summed by rate for the totals. There is no "success fee" line type (§6.8).
 */

// =================================================================================================
// Line items
// =================================================================================================

/** GST rates a quotation line may carry (§6.4: 18% default, 5%, 0% / exempt; the 40% slab exists). */
export const QUOTATION_TAX_RATES = ["18", "5", "0", "40"] as const;
export type QuotationTaxRate = (typeof QUOTATION_TAX_RATES)[number];

export const TAX_RATE_LABELS: Record<QuotationTaxRate, string> = {
  "18": "18% (default)",
  "5": "5%",
  "0": "0% / exempt",
  "40": "40%",
};

/** The default line description for a service. */
export const SERVICE_LINE_DEFAULTS: Record<ServiceType, string> = {
  gst: "GST compliance: GSTR-1, GSTR-3B and reconciliation",
  income_tax: "Income tax return preparation and filing",
  tds: "TDS returns and challans",
  payroll: "Payroll compliance: PF, ESIC and professional tax",
  bookkeeping: "Bookkeeping and monthly accounts",
  audit: "Audit",
  company_law: "ROC and company law compliance",
  incorporation: "Incorporation and registrations",
  other: "",
};

const CONTINGENT = /\b(success|contingen\w*|result[- ]based|performance[- ]based)\s+fee|\bfee\b[^.]{0,30}\b(contingent|depend\w*)\b[^.]{0,30}\b(result|outcome|refund|saving)|\d+(\.\d+)?\s*%\s*of\s+(the\s+)?(refund|savings?|tax\s+saved|profits?|recovery)/i;

/**
 * §6.8 (CA Act, First Schedule, Part I, Clause 10): a member in practice may not charge fees that
 * depend on the result of the work, so a quotation carries no success-fee line. Returns the
 * sentence to show when a description reads as one, else null.
 */
export function contingentFeeProblem(description: string): string | null {
  return CONTINGENT.test(description)
    ? "A fee that depends on the result of the work (a success fee or a share of a refund or saving) isn't allowed for a CA in practice. Quote a fixed fee instead."
    : null;
}

const decimal = (label: string, opts: { min: number; max: number; places: number; exclusiveMin?: boolean }) =>
  z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const raw = String(v).replace(/,/g, "").trim();
      const re = new RegExp(`^\\d+(\\.\\d{1,${opts.places}})?$`);
      if (!re.test(raw)) {
        ctx.addIssue({ code: "custom", message: `Enter the ${label} as a number${opts.places ? `, with at most ${opts.places} decimal places` : ""}.` });
        return z.NEVER;
      }
      const n = Number(raw);
      if (opts.exclusiveMin ? n <= opts.min : n < opts.min) {
        ctx.addIssue({ code: "custom", message: `The ${label} must be more than ${opts.min}.` });
        return z.NEVER;
      }
      if (n > opts.max) {
        ctx.addIssue({ code: "custom", message: `The ${label} can be at most ${opts.max.toLocaleString("en-IN")}.` });
        return z.NEVER;
      }
      return raw;
    });

const rupees = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const parsed = parseAmount(String(v));
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error === "Enter an amount." ? "Enter the unit price." : parsed.error });
    return z.NEVER;
  }
  if (parsed.paise > 9_99_99_99_999_99) {
    ctx.addIssue({ code: "custom", message: "That price is too large for one line." });
    return z.NEVER;
  }
  return (parsed.paise / 100).toFixed(2);
});

export const QuotationLineSchema = z
  .object({
    /** The builder's row key (not stored). */
    key: z.string().max(64).optional(),
    description: z
      .string()
      .trim()
      .min(2, { error: "Describe the service." })
      .max(500, { error: "Keep the description under 500 characters." }),
    service_type: z
      .union([z.enum(SERVICE_TYPES), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    frequency: z
      .union([z.enum(SERVICE_FREQUENCIES), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
    quantity: decimal("quantity", { min: 0, max: 9999.99, places: 2, exclusiveMin: true }),
    unit_price: rupees,
    tax_rate: z.enum(QUOTATION_TAX_RATES, { error: "Choose the GST rate." }),
  })
  .superRefine((v, ctx) => {
    const problem = contingentFeeProblem(v.description);
    if (problem) ctx.addIssue({ code: "custom", path: ["description"], message: problem });
  });
export type QuotationLineValues = z.input<typeof QuotationLineSchema>;
export type QuotationLineData = z.output<typeof QuotationLineSchema>;

// =================================================================================================
// The builder (§7.5.2)
// =================================================================================================

export const QUOTATION_PARTIES = ["lead", "client", "other"] as const;
export type QuotationParty = (typeof QUOTATION_PARTIES)[number];

const optionalUuid = z
  .union([z.uuid(), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const dateField = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isDateString(v), { error: `Choose the ${label}.` });

const QuotationFields = z.object({
  /** The Draft being edited; null until the first save. */
  id: optionalUuid,
  /** The Draft's updated_at when it was loaded or last saved (§13). */
  updatedAt: z.union([z.string(), z.null()]).optional().transform((v) => (v ? v : null)),
  party: z.enum(QUOTATION_PARTIES).default("other"),
  lead_id: optionalUuid,
  client_id: optionalUuid,
  client_name: z.string().trim().min(2, { error: "Enter the name of the person it's for." }).max(160, { error: "Keep the name under 160 characters." }),
  client_email: z
    .string()
    .trim()
    .min(1, { error: "Enter the client's email address." })
    .max(254)
    .refine((v) => z.email().safeParse(v).success, { error: "Enter a valid email address, like name@company.in." }),
  client_phone: z
    .string()
    .trim()
    .max(24)
    .default("")
    .refine((v) => v === "" || isPlausiblePhone(v), { error: "Enter a phone number with 10 digits (or the full number with its code)." }),
  client_company: z.string().trim().max(160, { error: "Keep the company name under 160 characters." }).default(""),
  client_gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .default("")
    .refine((v) => v === "" || validateGstin(v).ok, { error: "That GSTIN isn't valid: check the 15 characters (the last one is a checksum)." }),
  place_of_supply_code: z
    .string()
    .trim()
    .refine((v) => isValidStateCode(v), { error: "Choose the state the services are supplied to." }),
  issue_date: dateField("issue date"),
  valid_until: dateField("valid-until date"),
  notes: z.string().trim().max(4000, { error: "Keep the notes under 4,000 characters." }).default(""),
  terms: z.string().trim().max(8000, { error: "Keep the terms under 8,000 characters." }).default(""),
  lines: z.array(QuotationLineSchema).max(100, { error: "A quotation can have at most 100 lines." }).default([]),
});

function builderRules(v: z.output<typeof QuotationFields>, ctx: z.RefinementCtx) {
  if (compareDates(v.valid_until, v.issue_date) < 0) {
    ctx.addIssue({ code: "custom", path: ["valid_until"], message: "Valid until can't be before the issue date." });
  }
  if (v.client_gstin) {
    const g = deriveFromGstin(v.client_gstin);
    if (g && g.stateCode !== v.place_of_supply_code) {
      ctx.addIssue({
        code: "custom",
        path: ["place_of_supply_code"],
        message: `The GSTIN is registered in ${g.stateName} (${g.stateCode}), so that is the place of supply.`,
      });
    }
  }
  if (v.party === "lead" && !v.lead_id) ctx.addIssue({ code: "custom", path: ["lead_id"], message: "Choose the lead, or switch to another recipient." });
  if (v.party === "client" && !v.client_id) ctx.addIssue({ code: "custom", path: ["client_id"], message: "Choose the client, or switch to another recipient." });
}

export const QuotationDraftSchema = QuotationFields.superRefine(builderRules);
export type QuotationDraftValues = z.input<typeof QuotationDraftSchema>;
export type QuotationDraftData = z.output<typeof QuotationDraftSchema>;

/** The builder's empty form: today, valid for `validityDays`, the firm's terms, one line, the firm's state. */
export function emptyQuotationValues(opts: { today: DateString; validityDays: number; terms: string | null; firmStateCode?: string }): QuotationDraftValues {
  return {
    id: null,
    updatedAt: null,
    party: "other",
    lead_id: null,
    client_id: null,
    client_name: "",
    client_email: "",
    client_phone: "",
    client_company: "",
    client_gstin: "",
    place_of_supply_code: opts.firmStateCode ?? FIRM_STATE_CODE_DEFAULT,
    issue_date: opts.today,
    valid_until: addDays(opts.today, Math.max(1, opts.validityDays)),
    notes: "",
    terms: opts.terms ?? "",
    lines: [newLine()],
  };
}

let lineSeq = 0;

/** A new builder line (GST 18%, qty 1). */
export function newLine(over: Partial<QuotationLineValues> = {}): QuotationLineValues {
  lineSeq += 1;
  return {
    key: `l${Date.now().toString(36)}${lineSeq}`,
    description: "",
    service_type: "",
    frequency: "",
    quantity: "1",
    unit_price: "",
    tax_rate: "18",
    ...over,
  };
}

/** A line worth saving to the server draft: it has a description and a price that parse. */
export function isSavableLine(line: QuotationLineValues): boolean {
  return QuotationLineSchema.safeParse(line).success;
}

/**
 * The place of supply the builder shows (§6.4, §7.5.2 "derived"): the GSTIN's state when the GSTIN
 * is valid, otherwise the state chosen (or the client's state), otherwise the firm's own state.
 */
export function derivedPlaceOfSupply(gstin: string | null | undefined, chosen: string | null | undefined, firmStateCode = FIRM_STATE_CODE_DEFAULT): { code: string; locked: boolean } {
  const g = gstin ? deriveFromGstin(gstin) : null;
  if (g) return { code: g.stateCode, locked: true };
  const c = chosen?.trim() ?? "";
  return { code: isValidStateCode(c) ? c : firmStateCode, locked: false };
}

// =================================================================================================
// Totals and the tax split (§7.5.2 "subtotal, CGST/SGST or IGST split (by place of supply), total;
// total in words")
// =================================================================================================

export type TotalsLine = { quantity: number | string; unit_price: number | string; tax_rate: number | string };

export type QuotationLineAmounts = { amountPaise: Paise; taxPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; totalPaise: Paise };

export type TaxBand = { rate: number; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise };

export type QuotationTotals = {
  intraState: boolean;
  lines: QuotationLineAmounts[];
  subtotalPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
  /** Tax grouped by rate (only rates above 0): "CGST @ 9%", "SGST @ 9%" or "IGST @ 18%". */
  bands: TaxBand[];
  words: string;
};

function safeLine(l: TotalsLine): { amountPaise: Paise; taxPaise: Paise; rate: number } | null {
  try {
    const price = typeof l.unit_price === "number" ? toPaise(l.unit_price) : (() => {
      const p = parseAmount(String(l.unit_price));
      return p.ok ? p.paise : null;
    })();
    if (price === null) return null;
    const qtyText = String(l.quantity).replace(/,/g, "").trim();
    if (!/^\d+(\.\d+)?$/.test(qtyText) || Number(qtyText) <= 0) return null;
    const rate = Number(String(l.tax_rate).trim());
    if (!Number.isFinite(rate)) return null;
    const { amountPaise, taxPaise } = computeLine(qtyText, price, rate);
    return { amountPaise, taxPaise, rate };
  } catch {
    return null;
  }
}

/**
 * The quotation's totals: each line's amount and GST (half-up on the line), split per line into
 * CGST + SGST (same state as the firm) or IGST, then summed; plus the tax by rate and the total
 * in words. A line that doesn't parse yet (the builder mid-typing) counts as zero.
 */
export function quotationTotals(lines: readonly TotalsLine[], placeOfSupplyCode: string, firmStateCode = FIRM_STATE_CODE_DEFAULT): QuotationTotals {
  const intraState = isIntraState(placeOfSupplyCode, firmStateCode);
  const bands = new Map<number, TaxBand>();
  const computed: QuotationLineAmounts[] = lines.map((l) => {
    const c = safeLine(l);
    if (!c) return { amountPaise: 0, taxPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0 };
    const split = splitTax(c.taxPaise, intraState);
    if (c.rate > 0) {
      const band = bands.get(c.rate) ?? { rate: c.rate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
      band.taxablePaise += c.amountPaise;
      band.cgstPaise += split.cgstPaise;
      band.sgstPaise += split.sgstPaise;
      band.igstPaise += split.igstPaise;
      bands.set(c.rate, band);
    }
    return { amountPaise: c.amountPaise, taxPaise: c.taxPaise, ...split, totalPaise: c.amountPaise + c.taxPaise };
  });
  const subtotalPaise = sumPaise(computed.map((l) => l.amountPaise));
  const cgstPaise = sumPaise(computed.map((l) => l.cgstPaise));
  const sgstPaise = sumPaise(computed.map((l) => l.sgstPaise));
  const igstPaise = sumPaise(computed.map((l) => l.igstPaise));
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  const totalPaise = subtotalPaise + taxPaise;
  return {
    intraState,
    lines: computed,
    subtotalPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise,
    totalPaise,
    bands: [...bands.values()].sort((a, b) => b.rate - a.rate),
    words: amountInWords(totalPaise),
  };
}

/** "9%" for half of 18; "2.5%" for half of 5. */
export function halfRateLabel(rate: number): string {
  const half = rate / 2;
  return `${Number.isInteger(half) ? half : half.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** The rows of the totals block: Subtotal, CGST @ 9%, SGST @ 9% (or IGST @ 18%), Total. */
export function totalRows(t: QuotationTotals): Array<{ label: string; paise: Paise; emphasis?: boolean }> {
  const rows: Array<{ label: string; paise: Paise; emphasis?: boolean }> = [{ label: "Subtotal", paise: t.subtotalPaise }];
  for (const b of t.bands) {
    if (t.intraState) {
      rows.push({ label: `CGST @ ${halfRateLabel(b.rate)}`, paise: b.cgstPaise }, { label: `SGST @ ${halfRateLabel(b.rate)}`, paise: b.sgstPaise });
    } else {
      rows.push({ label: `IGST @ ${b.rate}%`, paise: b.igstPaise });
    }
  }
  if (t.bands.length === 0) rows.push({ label: t.intraState ? "CGST + SGST" : "IGST", paise: 0 });
  rows.push({ label: "Total", paise: t.totalPaise, emphasis: true });
  return rows;
}

/** "GST returns · Monthly" under a line's description. */
export function lineMeta(serviceType: ServiceType | null | undefined, frequency: ServiceFrequency | null | undefined): string | null {
  const parts = [serviceType && serviceType !== "other" ? SERVICE_TYPE_LABELS[serviceType] : null, frequency ? SERVICE_FREQUENCY_LABELS[frequency] : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** "Karnataka (29)". */
export function placeOfSupplyLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const name = stateName(code);
  return name ? `${name} (${code})` : code;
}

// =================================================================================================
// Status and what a quotation offers
// =================================================================================================

/** Sent or Viewed past valid_until shows as Expired before the nightly job catches up (§7.5.3). */
export function quotationDisplayStatus(status: QuotationStatus, validUntil: DateString, today: DateString): QuotationStatus {
  if ((status === "sent" || status === "viewed") && compareDates(validUntil, today) < 0) return "expired";
  return status;
}

export const OPEN_QUOTATION_STATUSES: readonly QuotationStatus[] = ["pending_approval", "approved", "sent", "viewed"];
export const REVISABLE_STATUSES: readonly QuotationStatus[] = ["pending_approval", "approved", "sent", "viewed", "rejected", "expired"];

export type QuotationActionInput = {
  status: QuotationStatus;
  validUntil: DateString;
  today: DateString;
  createdByRole: AppRole | null;
  totalPaise: Paise;
  limitPaise: Paise | null;
  lineCount: number;
  convertedClientId: string | null;
  clientId: string | null;
  deleted: boolean;
};

export type QuotationActions = {
  edit: boolean;
  submitForApproval: boolean;
  decideApproval: boolean;
  send: boolean;
  /** Why Send isn't offered, when it would be the natural next step. */
  sendBlockedReason: string | null;
  resend: boolean;
  followUp: boolean;
  revise: boolean;
  remove: boolean;
  createClient: boolean;
  needsApproval: boolean;
};

/**
 * What the quotation page offers the viewer (§7.5.2, §7.5.3), from its status: a Draft is edited
 * and then sent, or submitted for approval when the author is a Manager over the limit; a Partner
 * approves or returns one pending approval; Sent and Viewed ones are resent and followed up;
 * anything sent or answered is revised, never edited; an accepted one becomes a client once.
 */
export function quotationActions(q: QuotationActionInput, viewerRole: AppRole): QuotationActions {
  const live = !q.deleted;
  const lapsed = compareDates(q.validUntil, q.today) < 0;
  const needsApproval = quotationNeedsApproval(q.createdByRole ?? "manager", q.totalPaise, q.limitPaise);
  const draft = live && q.status === "draft";
  let sendBlockedReason: string | null = null;
  if (draft || q.status === "approved") {
    if (q.lineCount === 0) sendBlockedReason = "Add at least one line before sending it.";
    else if (lapsed) sendBlockedReason = "The valid-until date has passed. Move it to a later date first.";
    else if (draft && needsApproval) sendBlockedReason = "Over the quotation approval limit: submit it for a Partner's approval first.";
  }
  const canSendNow = live && (draft || q.status === "approved") && sendBlockedReason === null;
  const open = live && (q.status === "sent" || q.status === "viewed") && !lapsed;
  return {
    edit: draft,
    submitForApproval: draft && needsApproval && q.lineCount > 0 && !lapsed && viewerRole !== "partner",
    decideApproval: live && q.status === "pending_approval" && viewerRole === "partner",
    send: canSendNow,
    sendBlockedReason: live && (draft || q.status === "approved") ? sendBlockedReason : null,
    resend: open,
    followUp: open,
    revise: live && REVISABLE_STATUSES.includes(q.status),
    remove: live && q.status !== "accepted",
    createClient: live && q.status === "accepted" && !q.convertedClientId && !q.clientId,
    needsApproval,
  };
}

// =================================================================================================
// The client's link (§7.23)
// =================================================================================================

export const EXPIRED_MESSAGE = "This quotation has expired. Contact TaxWise for an updated one.";
export const SUPERSEDED_MESSAGE = "This quotation has been replaced by a newer version";

export type PublicState =
  | { kind: "open" }
  | { kind: "accepted"; respondedAt: string | null; acceptedByName: string | null }
  | { kind: "declined"; respondedAt: string | null }
  | { kind: "expired" }
  | { kind: "superseded" }
  | { kind: "unavailable" };

/** What the public page shows instead of (or with) the Accept / Decline buttons. */
export function publicState(q: { status: QuotationStatus; valid_until: DateString; responded_at: string | null; accepted_by_name: string | null; deleted_at: string | null }, today: DateString): PublicState {
  if (q.deleted_at) return { kind: "unavailable" };
  switch (q.status) {
    case "accepted":
      return { kind: "accepted", respondedAt: q.responded_at, acceptedByName: q.accepted_by_name };
    case "rejected":
      return { kind: "declined", respondedAt: q.responded_at };
    case "superseded":
      return { kind: "superseded" };
    case "expired":
      return { kind: "expired" };
    case "sent":
    case "viewed":
      return compareDates(q.valid_until, today) < 0 ? { kind: "expired" } : { kind: "open" };
    default:
      return { kind: "unavailable" };
  }
}

export const RespondSchema = z.discriminatedUnion("response", [
  z.object({
    response: z.literal("accept"),
    name: z
      .string()
      .trim()
      .min(2, { error: "Type your full name to accept." })
      .max(120, { error: "Keep your name under 120 characters." })
      .refine((v) => /\p{L}/u.test(v), { error: "Type your full name to accept." }),
    note: z.string().trim().max(2000, { error: "Keep the note under 2,000 characters." }).default(""),
  }),
  z.object({
    response: z.literal("decline"),
    reason: z.string().trim().min(3, { error: "Tell us briefly why you are declining." }).max(2000, { error: "Keep the reason under 2,000 characters." }),
  }),
]);
export type RespondInput = z.input<typeof RespondSchema>;

/** What the client's Accept / Decline returns (server/quotations-public.ts respondPublic). */
export type RespondResult =
  | { ok: true; outcome: "accepted" | "declined"; respondedAt: string | null; acceptedByName: string | null }
  | { ok: false; error: string; field?: "name" | "note" | "reason"; outcome?: string };

/** A public token: 32 random bytes, URL-safe base64 (43 characters). */
export function isQuotationToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(v);
}

// =================================================================================================
// Follow-ups (§7.5.3 "day 3, 7 and 14 after sending, while the quotation is still Sent/Viewed and
// not expired")
// =================================================================================================

export type FollowUpRow = { id: string; follow_up_day: number; scheduled_at: string; status: string };

/**
 * Which follow-up to send now: the latest one due (scheduled_at ≤ now) that is still pending; any
 * earlier pending one is skipped (a later reminder replaces it). Null when none is due.
 */
export function dueFollowUp(rows: readonly FollowUpRow[], now: Date): { due: FollowUpRow; skip: FollowUpRow[] } | null {
  const due = rows
    .filter((r) => r.status === "pending" && Date.parse(r.scheduled_at) <= now.getTime())
    .sort((a, b) => a.follow_up_day - b.follow_up_day);
  if (due.length === 0) return null;
  const latest = due[due.length - 1];
  return { due: latest, skip: due.slice(0, -1) };
}

/** The follow-up tone (3, 7 or 14, §7.5.3); other configured days use the nearest shorter tone. */
export function followUpTone(day: number): 3 | 7 | 14 {
  if (day >= 14) return 14;
  if (day >= 7) return 7;
  return 3;
}

export type ChipInfo = { label: string; tone: "success" | "warning" | "danger" | "info" | "muted" | "neutral"; meaning: string };

/** A follow-up's status as the quotation page shows it: Scheduled, Due, Handed off, Skipped (and Emailed / Failed on older ones). */
export function followUpStatusInfo(row: { status: string; scheduled_at: string }, now: Date, open: boolean): ChipInfo {
  switch (row.status) {
    case "sent":
      return { label: "Emailed", tone: "info", meaning: "Emailed to the client (an older follow-up, from before the firm moved to WhatsApp only)." };
    case "handed_off":
      return { label: "Handed off", tone: "info", meaning: "Opened in WhatsApp by someone here. The app can't confirm it was sent." };
    case "skipped":
      return { label: "Skipped", tone: "muted", meaning: "Not needed: the quotation was answered, expired or revised, or a later follow-up replaced it." };
    case "failed":
      return open
        ? { label: "Failed", tone: "danger", meaning: "An older email that didn't go through. Send it on WhatsApp instead." }
        : { label: "Failed", tone: "muted", meaning: "An older email that didn't go through; the quotation is no longer open." };
    default: {
      if (!open) return { label: "Not sent", tone: "muted", meaning: "The quotation is no longer open, so this follow-up won't go." };
      const due = Date.parse(row.scheduled_at) <= now.getTime();
      return due
        ? { label: "Due", tone: "warning", meaning: "Due now: send it on WhatsApp, the message is ready. The author is told in the Inbox." }
        : { label: "Scheduled", tone: "muted", meaning: "Falls due on its day, if the quotation is still open. The author is then told to send it on WhatsApp." };
    }
  }
}

/** A send's status (quotation_email_logs) as the page shows it; hand-offs are never "delivered" (§7.13.1). Email ones are older sends. */
export function sendStatusInfo(channel: string, status: string): ChipInfo {
  if (channel === "internal_note") return { label: "Link copied", tone: "muted", meaning: "The link was copied to share by hand. The app can't see where it went." };
  if (channel === "whatsapp_handoff" || channel === "gmail_handoff") {
    return { label: "Handed off", tone: "info", meaning: `Opened in ${channel === "whatsapp_handoff" ? "WhatsApp" : "Gmail"} with the message filled in. The app can't confirm it was sent.` };
  }
  switch (status) {
    case "delivered":
      return { label: "Delivered", tone: "success", meaning: "Delivered: the client's mail server accepted it." };
    case "opened":
      return { label: "Opened", tone: "success", meaning: "Opened: the client opened the email (where their mail app lets us tell)." };
    case "bounced":
      return { label: "Bounced", tone: "danger", meaning: "Bounced: the address didn't accept it. Send it on WhatsApp instead." };
    case "failed":
      return { label: "Failed", tone: "danger", meaning: "Failed: it didn't reach the client. Send it on WhatsApp instead." };
    case "sent":
      return { label: "Sent", tone: "info", meaning: "Sent: the email was accepted for delivery." };
    default:
      return { label: status.replace(/_/g, " "), tone: "neutral", meaning: "" };
  }
}

/**
 * The WhatsApp follow-up draft (§7.5.3, the §10.6 tones: each shorter than the last), with the
 * quotation's link. `amount` and the dates come formatted.
 */
export function followUpWhatsApp(d: { day: number; firstName: string; number: string; amount: string; validUntil: string; sentOn: string; link: string; firmPhone?: string | null }): string {
  const hi = d.firstName ? `Hi ${d.firstName}, ` : "Hello, ";
  switch (followUpTone(d.day)) {
    case 3:
      return `${hi}following up on our quotation ${d.number}, sent on ${d.sentOn}. Any questions about the scope or the fees? Happy to walk you through it${d.firmPhone ? ` (${d.firmPhone})` : ""}.\n\n${d.link}`;
    case 7:
      return `${hi}a reminder that quotation ${d.number} (${d.amount}) is valid until ${d.validUntil}. You can accept it here: ${d.link}`;
    default:
      return `${hi}quotation ${d.number} is valid until ${d.validUntil}: ${d.link}`;
  }
}

export const QUOTATION_EMAIL_TYPE_LABELS: Record<string, string> = {
  initial: "Quotation",
  revision: "Revised quotation",
  follow_up_3: "Follow-up, day 3",
  follow_up_7: "Follow-up, day 7",
  follow_up_14: "Follow-up, day 14",
  acceptance_confirmation: "Acceptance confirmation",
};

export function emailTypeLabel(t: string): string {
  if (QUOTATION_EMAIL_TYPE_LABELS[t]) return QUOTATION_EMAIL_TYPE_LABELS[t];
  const m = /^follow_up_(\d+)$/.exec(t);
  return m ? `Follow-up, day ${m[1]}` : t.replace(/_/g, " ");
}

/** How each send went out. Email and Gmail are older sends; new ones are WhatsApp or a copied link. */
export const CHANNEL_SEND_LABELS: Record<string, string> = {
  whatsapp_handoff: "WhatsApp",
  internal_note: "Link copied",
  email: "Email",
  gmail_handoff: "Gmail",
};

// =================================================================================================
// Action inputs
// =================================================================================================

export const QuotationRefSchema = z.object({
  id: z.uuid({ error: "That quotation isn't valid." }),
  updatedAt: z.string().min(1),
});

export const ApprovalDecisionSchema = z
  .object({
    id: z.uuid({ error: "That quotation isn't valid." }),
    updatedAt: z.string().min(1),
    decision: z.enum(["approve", "return"]),
    note: z.string().trim().max(2000, { error: "Keep the comments under 2,000 characters." }).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "return" && v.note.length < 3) ctx.addIssue({ code: "custom", path: ["note"], message: "Say what needs to change, so it can be fixed and submitted again." });
  });
export type ApprovalDecisionInput = z.input<typeof ApprovalDecisionSchema>;

export const QuotationHandoffSchema = z.object({
  id: z.uuid({ error: "That quotation isn't valid." }),
  /** Null for a follow-up (the quotation is already sent). */
  updatedAt: z.union([z.string(), z.null()]).optional().transform((v) => (v ? v : null)),
  channel: z.enum(["whatsapp_handoff", "internal_note"]),
  recipient: z.string().trim().max(320).default(""),
  subject: z.string().trim().max(300).default(""),
  body: z.string().trim().max(10_000).default(""),
  /** A day-N follow-up handed off by a person; null for the first send. */
  followUpDay: z.union([z.number().int().min(1).max(365), z.null()]).optional().transform((v) => v ?? null),
});
export type QuotationHandoffInput = z.input<typeof QuotationHandoffSchema>;

// =================================================================================================
// The list
// =================================================================================================

export const QUOTATION_SORTABLE = ["quotation_number", "client_name", "issue_date", "valid_until", "total", "status", "sent_at", "created_at", "last_viewed_at"] as const;
export type QuotationSort = (typeof QUOTATION_SORTABLE)[number];

export const QUOTATION_FLAGS = ["mine", "needs_handoff", "lapsed", "converted", "not_converted"] as const;
export type QuotationFlag = (typeof QUOTATION_FLAGS)[number];

export const QUOTATION_FLAG_LABELS: Record<QuotationFlag, string> = {
  mine: "Prepared by me",
  needs_handoff: "Follow-up to send",
  lapsed: "Past valid-until",
  converted: "Converted to a client",
  not_converted: "Accepted, not yet a client",
};

export const QUOTATION_FILTERS = {
  status: QUOTATION_STATUSES,
  author: null,
  flag: QUOTATION_FLAGS,
} as const;
export type QuotationFilter = keyof typeof QUOTATION_FILTERS;

/** The default valid-until for an issue date (§7.5.2 "today + validity days from Settings"). */
export function defaultValidUntil(issueDate: DateString, validityDays: number): DateString {
  return addDays(issueDate, Math.max(1, Math.floor(validityDays)));
}

// =================================================================================================
// The document (one shape for the staff page, the PDF and the client's page: "same layout as the PDF", §7.23)
// =================================================================================================

export type QuotationDocumentLine = {
  description: string;
  serviceType: ServiceType | null;
  frequency: ServiceFrequency | null;
  quantity: string;
  unitPrice: string;
  taxRate: string;
};

export type QuotationDocument = {
  id: string;
  number: string;
  status: QuotationStatus;
  issueDate: DateString;
  validUntil: DateString;
  revisionNumber: number;
  /** The quotation this one revises (its number). */
  revisesNumber: string | null;
  preparedBy: string | null;
  recipient: {
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    gstin: string | null;
    placeOfSupplyCode: string;
  };
  lines: QuotationDocumentLine[];
  notes: string | null;
  terms: string | null;
  /** "Accepted electronically by <name> on <date>" (§7.5.3 acceptance block). */
  acceptance: { name: string; at: string | null } | null;
};

/** The recipient's heading in "Prepared for": the company, else the person. */
export function recipientHeading(r: QuotationDocument["recipient"]): { primary: string; secondary: string | null } {
  const company = r.company?.trim();
  return company ? { primary: company, secondary: `Attn: ${r.name}` } : { primary: r.name, secondary: null };
}

/** The firm as the quotation's letterhead shows it (the public subset, §4.6). */
export type DocumentFirm = {
  firmName: string;
  legalName: string | null;
  tagline: string | null;
  addressLine: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  logoUrl: string | null;
  stateCode: string;
};
