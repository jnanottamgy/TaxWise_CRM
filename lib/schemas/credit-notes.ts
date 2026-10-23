import { z } from "zod";
import { CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_LABELS, type CreditNoteReason } from "@/lib/domain/enums";
import { isDateString, type DateString } from "@/lib/domain/fy";
import { GST_DEFAULTS, checkCreditNote, creditNoteAmounts, type CreditNoteAmounts, type CreditNoteCheck, type GstParams } from "@/lib/domain/gst";
import { formatINR, paiseToDecimalString, parseAmount, toPaise, type Paise } from "@/lib/domain/money";

/**
 * Credit notes (§7.9.7, §6.4 s.34): the form and its action, and the helpers the form shows: the
 * taxable value still creditable at each GST rate on the invoice, the GST at the invoice's rate split
 * the invoice's way, and the s.34 deadline with its warning from 30 days before and the refusal
 * after it for a tax-reducing note (a commercial credit is still allowed, with a notice). Partner
 * only (§4.1). Client-safe.
 */

export const CREDIT_NOTE_LIMITS = { reason: 1000, notes: 2000 } as const;

export const CREDIT_NOTE_REASON_OPTIONS: Array<{ value: CreditNoteReason; label: string }> = CREDIT_NOTE_REASONS.map((r) => ({
  value: r,
  label: CREDIT_NOTE_REASON_LABELS[r],
}));

export const IssueCreditNoteSchema = z
  .object({
    invoiceId: z.uuid({ error: "Choose the invoice." }),
    reasonCode: z.union([z.enum(CREDIT_NOTE_REASONS), z.literal("")]).refine((v) => v !== "", { error: "Choose the reason code." }),
    reason: z
      .string()
      .trim()
      .min(1, { error: "Explain the reason for the credit note." })
      .max(CREDIT_NOTE_LIMITS.reason),
    taxableAmount: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .superRefine((v, ctx) => {
        const p = parseAmount(v);
        if (!p.ok) ctx.addIssue({ code: "custom", message: v === "" ? "Enter the taxable amount to credit." : p.error });
        else if (p.paise <= 0) ctx.addIssue({ code: "custom", message: "Enter the taxable amount to credit." });
      }),
    taxRate: z.string().trim().optional().default(""),
    /** False = a commercial credit: reduces what the client owes, not the GST (§6.4). */
    reducesGst: z.boolean().default(true),
    issueDate: z
      .string()
      .trim()
      .refine((v) => isDateString(v), { error: "Enter the credit note date." }),
    /** The date TaxWise filed its annual return for the invoice's FY, if filed (s.34). */
    annualReturnFiledOn: z
      .string()
      .trim()
      .optional()
      .default("")
      .refine((v) => v === "" || isDateString(v), { error: "Enter the filing date, for example 15 Oct 2027." }),
    notes: z.string().trim().max(CREDIT_NOTE_LIMITS.notes).optional().default(""),
  })
  .superRefine((v, ctx) => {
    if (v.reducesGst && !/^\d{1,3}(\.\d{1,2})?$/.test(v.taxRate)) ctx.addIssue({ code: "custom", path: ["taxRate"], message: "Choose the GST rate to credit at." });
  });
export type IssueCreditNoteInput = z.input<typeof IssueCreditNoteSchema>;
export type IssueCreditNoteValues = z.output<typeof IssueCreditNoteSchema>;

/** The jsonb issue_credit_note takes (0153). */
export function creditNotePayload(v: IssueCreditNoteValues): Record<string, unknown> {
  return {
    invoice_id: v.invoiceId,
    reason_code: v.reasonCode,
    reason: v.reason,
    taxable_amount: paiseToDecimalString(toPaise(v.taxableAmount)),
    tax_rate: v.reducesGst ? v.taxRate : null,
    reduces_gst: v.reducesGst,
    issue_date: v.issueDate,
    annual_return_filed_on: v.annualReturnFiledOn || null,
    notes: v.notes || null,
  };
}

export type CreditableRate = {
  ratePercent: number;
  /** Taxable value of the invoice's lines at this rate. */
  taxablePaise: Paise;
  /** Already credited at this rate by tax-reducing credit notes. */
  creditedPaise: Paise;
  remainingPaise: Paise;
};

/**
 * The taxable value still creditable at each GST rate on the invoice (§7.9.7 "≤ remaining taxable
 * value"), highest rate first; reimbursement lines aren't taxable and commercial credits don't use
 * up taxable value. Mirrors issue_credit_note.
 */
export function creditableRates(
  items: ReadonlyArray<{ amount: number | string; tax_rate: number | string; is_reimbursement: boolean }>,
  creditNotes: ReadonlyArray<{ taxable_amount: number | string; tax_rate: number | string | null; reduces_gst: boolean }>,
): CreditableRate[] {
  const byRate = new Map<number, { taxable: Paise; credited: Paise }>();
  for (const i of items) {
    if (i.is_reimbursement) continue;
    const rate = Number(i.tax_rate);
    const cur = byRate.get(rate) ?? { taxable: 0, credited: 0 };
    cur.taxable += toPaise(i.amount);
    byRate.set(rate, cur);
  }
  for (const c of creditNotes) {
    if (!c.reduces_gst || c.tax_rate === null) continue;
    const rate = Number(c.tax_rate);
    const cur = byRate.get(rate);
    if (cur) cur.credited += toPaise(c.taxable_amount);
  }
  return [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([ratePercent, v]) => ({ ratePercent, taxablePaise: v.taxable, creditedPaise: v.credited, remainingPaise: Math.max(0, v.taxable - v.credited) }));
}

export type CreditNotePreview = {
  amounts: CreditNoteAmounts | null;
  check: CreditNoteCheck;
  /** Problems with the amount, for the field. */
  amountError: string | null;
  /** The client has paid more than this leaves due: what the firm would owe back. */
  refundPaise: Paise;
};

/**
 * What the credit note will be (§7.9.7): its GST and total at the chosen rate, split by the invoice's
 * place of supply; the s.34 check (§6.4) for its date; and, for a tax-reducing note, the remaining
 * taxable value at that rate; for a commercial credit, the outstanding amount.
 */
export function creditNotePreview(
  input: {
    taxableText: string;
    ratePercent: number | null;
    reducesGst: boolean;
    invoiceDate: DateString;
    creditNoteDate: DateString;
    annualReturnFiledOn: DateString | null;
    placeOfSupplyCode: string;
    firmStateCode: string;
    remainingTaxablePaise: Paise;
    outstandingPaise: Paise;
  },
  params: Pick<GstParams, "creditNoteDeadline" | "creditNoteWarnDays"> = GST_DEFAULTS,
): CreditNotePreview {
  const check = checkCreditNote(
    { invoiceDate: input.invoiceDate, annualReturnFiledOn: input.annualReturnFiledOn, creditNoteDate: input.creditNoteDate, reducesTax: input.reducesGst },
    params,
  );
  const parsed = input.taxableText.trim() === "" ? null : parseAmount(input.taxableText);
  const taxable = parsed && parsed.ok ? parsed.paise : 0;
  let amountError: string | null = null;
  let amounts: CreditNoteAmounts | null = null;
  if (parsed && !parsed.ok) amountError = parsed.error;
  else if (taxable > 0) {
    if (input.reducesGst) {
      if (taxable > input.remainingTaxablePaise) {
        amountError = `You can credit at most ${formatINR(input.remainingTaxablePaise)}, the taxable value at ${input.ratePercent ?? 0}% not yet credited on this invoice.`;
      }
      if (input.ratePercent !== null) amounts = creditNoteAmounts(taxable, input.ratePercent, input.placeOfSupplyCode, input.firmStateCode);
    } else {
      if (taxable > Math.max(0, input.outstandingPaise)) {
        amountError = `A commercial credit can't be more than the ${formatINR(Math.max(0, input.outstandingPaise))} outstanding on this invoice.`;
      }
      amounts = { taxablePaise: taxable, taxPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: taxable };
    }
  }
  const refundPaise = amounts && amounts.totalPaise > input.outstandingPaise ? amounts.totalPaise - Math.max(0, input.outstandingPaise) : 0;
  return { amounts, check, amountError, refundPaise };
}
