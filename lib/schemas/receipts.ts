import { z } from "zod";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/domain/enums";
import { financialYearOf, isDateString, quarterOf, type DateString } from "@/lib/domain/fy";
import { paiseToDecimalString, parseAmount, type Paise } from "@/lib/domain/money";
import {
  TDS_SECTION_OTHER,
  expectedTds,
  tdsDifference,
  tdsRuleLabel,
  validateReceipt,
  type ReceiptCheck,
  type TdsDifference,
  type TdsRule,
} from "@/lib/domain/tds";

/**
 * Receipts (§7.9.4, §6.5): the Record receipt form and its action, the reversal, the WhatsApp
 * message that goes with the receipt PDF, and the helpers the form shows: the TDS section picker
 * from the parameters in force on the payment date, the expected TDS on the taxable value excluding
 * GST (CBDT Circular 23/2017) with the difference from what the client deducted, and the
 * received + TDS ≤ outstanding + ₹1 check. Client-safe.
 */

export const RECEIPT_LIMITS = { reference: 120, depositedTo: 120, notes: 2000, reason: 500 } as const;

/** The suggested WhatsApp message with a receipt PDF (§7.9.4): what was received, against which invoice, and what is left. */
export function receiptShareText(r: {
  contactName: string | null;
  receiptNumber: string;
  invoiceNumber: string;
  paymentDate: string;
  /** "₹10,620.00", formatted. */
  amount: string;
  /** "₹1,180.00" TDS deducted, or null. */
  tds: string | null;
  /** "₹2,000.00" still outstanding on the invoice, or null when it is settled. */
  balance: string | null;
  firmName: string;
}): string {
  const first = r.contactName?.trim().split(/\s+/)[0];
  return [
    `${first ? `Hi ${first}` : "Hello"}, thank you for your payment of ${r.amount}${r.tds ? ` (and TDS of ${r.tds})` : ""} received on ${r.paymentDate} against invoice ${r.invoiceNumber}.`,
    "",
    `Please find receipt ${r.receiptNumber} from ${r.firmName} attached.`,
    r.balance ? `${r.balance} is still to pay on the invoice.` : "The invoice is now fully paid.",
    ...(r.tds ? ["", "Please send us the TDS certificate (Form 16A) once it's issued, so we can claim the credit."] : []),
  ].join("\n");
}

/** §7.9.4 "Bank transfer NEFT/IMPS/RTGS · UPI · Cheque · Cash · Card · Other". */
export const PAYMENT_METHOD_OPTIONS: Array<{ value: PaymentMethod; label: string }> = PAYMENT_METHODS.map((m) => ({
  value: m,
  label: m === "bank_transfer" ? "Bank transfer (NEFT / IMPS / RTGS)" : PAYMENT_METHOD_LABELS[m],
}));

/** What the reference field asks for, by method. */
export function referenceLabel(method: PaymentMethod | "" | null | undefined): string {
  switch (method) {
    case "bank_transfer":
      return "UTR";
    case "upi":
      return "UPI reference";
    case "cheque":
      return "Cheque no.";
    case "card":
      return "Card transaction no.";
    default:
      return "Reference";
  }
}

const money = (label: string, opts: { required: boolean }) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .default("")
    .transform((v) => String(v).trim())
    .superRefine((v, ctx) => {
      if (v === "") {
        if (opts.required) ctx.addIssue({ code: "custom", message: `Enter the ${label}.` });
        return;
      }
      const p = parseAmount(v);
      if (!p.ok) ctx.addIssue({ code: "custom", message: p.error });
    });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .optional()
    .default("");

export const RecordReceiptSchema = z
  .object({
    invoiceId: z.uuid({ error: "Choose the invoice." }),
    invoiceUpdatedAt: z.string().nullish().transform((v) => v ?? null),
    paymentDate: z
      .string()
      .trim()
      .refine((v) => isDateString(v), { error: "Enter the payment date, for example 22 Oct 2026." }),
    amountReceived: money("amount received", { required: true }),
    tdsAmount: money("TDS deducted", { required: false }),
    tdsSection: z.string().trim().max(20).optional().default(""),
    method: z.union([z.enum(PAYMENT_METHODS), z.literal("")]).refine((v) => v !== "", { error: "Choose how the client paid." }),
    reference: optionalText(RECEIPT_LIMITS.reference),
    depositedTo: optionalText(RECEIPT_LIMITS.depositedTo),
    notes: optionalText(RECEIPT_LIMITS.notes),
    /** A portal "I've paid" claim this receipt answers (§7.22). */
    claimId: z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    const tds = v.tdsAmount === "" ? 0 : parseAmount(v.tdsAmount).ok ? (parseAmount(v.tdsAmount) as { paise: number }).paise : 0;
    if (tds > 0 && v.tdsSection === "") ctx.addIssue({ code: "custom", path: ["tdsSection"], message: "Choose the section the client deducted TDS under." });
  });
export type RecordReceiptInput = z.input<typeof RecordReceiptSchema>;
export type RecordReceiptValues = z.output<typeof RecordReceiptSchema>;

/** Rupee text → paise; empty or unreadable → 0. */
export function paiseOf(value: string | null | undefined): Paise {
  if (!value || value.trim() === "") return 0;
  const p = parseAmount(value);
  return p.ok ? p.paise : 0;
}

/** The jsonb record_receipt takes (0152). */
export function receiptPayload(v: RecordReceiptValues): Record<string, unknown> {
  const tds = paiseOf(v.tdsAmount);
  return {
    invoice_id: v.invoiceId,
    invoice_updated_at: v.invoiceUpdatedAt,
    payment_date: v.paymentDate,
    amount_received: paiseToDecimalString(paiseOf(v.amountReceived)),
    tds_amount: paiseToDecimalString(tds),
    tds_section: tds > 0 ? v.tdsSection : null,
    method: v.method,
    reference: v.reference || null,
    deposited_to: v.depositedTo || null,
    notes: v.notes || null,
    claim_id: v.claimId,
  };
}

/** Client-side mirror of record_receipt's limit: received + TDS ≤ outstanding + ₹1 (§7.9.4). */
export function checkReceiptAmounts(v: { amountReceived: string; tdsAmount: string }, outstandingPaise: Paise): ReceiptCheck {
  const check = validateReceipt({ amountReceivedPaise: paiseOf(v.amountReceived), tdsPaise: paiseOf(v.tdsAmount), outstandingPaise });
  if (check.ok) return check;
  // The form's names are camel case.
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, msgs] of Object.entries(check.fieldErrors)) fieldErrors[k === "amount_received" ? "amountReceived" : k === "tds_amount" ? "tdsAmount" : k] = msgs;
  return { ok: false, error: check.error, fieldErrors };
}

export const ReverseReceiptSchema = z.object({
  receiptId: z.uuid({ error: "That receipt isn't valid." }),
  reason: z
    .string()
    .trim()
    .min(1, { error: "Say why the receipt is being reversed, for example \"Cheque bounced\"." })
    .max(RECEIPT_LIMITS.reason),
});
export type ReverseReceiptInput = z.input<typeof ReverseReceiptSchema>;

/**
 * A client's "I've paid" from the portal that the firm can't find in its bank (§7.22): it is closed
 * as not received with a reason kept in the invoice's history (staff only, never on the claim the
 * client can read). Carries the claim's updated_at, so a claim another person already handled isn't
 * overwritten (§13).
 */
export const RejectPaymentClaimSchema = z.object({
  claimId: z.uuid({ error: "That payment report isn't valid." }),
  updatedAt: z.string().trim().min(1, { error: "Reload the page and try again." }),
  reason: z
    .string()
    .trim()
    .min(3, { error: "Say why, for example \"No UTR 4100… in the bank statement up to 23 Oct\"." })
    .max(1000, { error: "Keep it under 1,000 characters." }),
});
export type RejectPaymentClaimInput = z.input<typeof RejectPaymentClaimSchema>;

// -------------------------------------------------------------------------------------------------
// TDS on the receipt (§6.5)
// -------------------------------------------------------------------------------------------------

export type TdsSectionOption = { value: string; label: string; ratePercent: number | null; verified: boolean };

/**
 * The TDS section picker for a payment date (§7.9.4 "TDS section (from parameters)"): every nature's
 * rule in force, professional fees first (TaxWise's usual), then "Other section". A rule's value is
 * its nature, so two natures under one section (194J professional / technical) stay apart.
 */
export function tdsSectionOptions(rules: readonly TdsRule[]): TdsSectionOption[] {
  const sorted = [...rules].sort((a, b) => (a.nature === "professional" ? -1 : b.nature === "professional" ? 1 : 0));
  return [
    ...sorted.map((r) => ({ value: `${r.section}:${r.nature}`, label: tdsRuleLabel(r), ratePercent: r.ratePercent, verified: r.verified })),
    { value: TDS_SECTION_OTHER, label: "Other section", ratePercent: null, verified: true },
  ];
}

/** The section stored on the receipt (§5.7 tds_section: 194J, 194C, 194H, 194I, 393 or OTHER) from a picker value. */
export function storedTdsSection(pickerValue: string): string {
  const section = pickerValue.split(":")[0]?.trim() ?? "";
  return section === "" ? TDS_SECTION_OTHER : section.toUpperCase();
}

export type TdsSuggestion = {
  /** taxable × rate, half-up to the paisa, less TDS already recorded on earlier receipts. */
  expectedPaise: Paise;
  ratePercent: number;
  /** The difference between what the client deducted and the expectation, in words. */
  difference: TdsDifference | null;
};

/**
 * The expected TDS for a receipt (§6.5, §7.9.4): on the invoice's taxable value excluding GST (CBDT
 * Circular 23/2017), at the picked section's rate, less what earlier receipts on the invoice already
 * recorded; with the difference from the TDS the client actually deducted. Null without a rate.
 */
export function tdsSuggestion(input: {
  taxablePaise: Paise;
  ratePercent: number | null;
  tdsAlreadyPaise: Paise;
  tdsDeductedText: string;
}): TdsSuggestion | null {
  if (input.ratePercent === null || !(input.ratePercent > 0)) return null;
  const expectedPaise = Math.max(0, expectedTds(input.taxablePaise, input.ratePercent) - input.tdsAlreadyPaise);
  const typed = input.tdsDeductedText.trim();
  const difference = typed === "" ? null : tdsDifference(expectedPaise, paiseOf(typed));
  return { expectedPaise, ratePercent: input.ratePercent, difference };
}

/** The TDS quarter a payment falls in ("Q3 2026-27"), as record_receipt stores it. */
export function tdsQuarterLabel(paymentDate: DateString): string {
  return `Q${quarterOf(paymentDate)} ${financialYearOf(paymentDate)}`;
}

export const TDS_STATUS_LABEL: Record<string, string> = {
  expected: "Expected",
  reflected: "Reflected in 26AS / AIS",
  claimed: "Claimed",
};
