import { z } from "zod";
import { SERVICE_FREQUENCIES, SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums";
import { isDateString } from "@/lib/domain/fy";
import { paiseToDecimalString, parseAmount } from "@/lib/domain/money";

/**
 * Services & fees on Client 360 (§7.3.3 tab 3, §5.3 client_services, Partner/Manager only): add a
 * service, change its terms (frequency, next due, billing frequency, SAC, auto-invoice and next
 * billing date), re-price it (records fee_agreed_at; the 0017 trigger writes the fee history) and
 * end it. Shared by the forms and server/actions/client-services.ts. Client-safe.
 *
 * Money arrives as the rupee string a MoneyInput holds ("12500" or "12500.50", "" when empty) and
 * leaves as a numeric(12,2) decimal string; it is never a float (§0.1 rule 7).
 */

export const SERVICE_LIMITS = { customName: 80, reason: 500, maxFeeRupees: 99_99_99_999 } as const;

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const dateOrNull = (label: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isDateString(v), { error: `Enter the ${label} as a date, for example 22 Oct 2026.` });

/** SAC on TaxWise's invoices (§6.4): 4 or 6 digits starting 99. Empty = the firm's map. */
const sacCode = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.replace(/\s+/g, "") : null))
  .refine((v) => v === null || /^99\d{2}(\d{2})?$/.test(v), { error: "Enter the SAC: 4 or 6 digits starting 99, for example 9982 or 998231." });

/** An agreed fee in rupees (excl. GST) → decimal string, or null when left empty. */
const feeOrNull = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const r = parseAmount(String(v));
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    if (r.paise > SERVICE_LIMITS.maxFeeRupees * 100) {
      ctx.addIssue({ code: "custom", message: "That fee is too large. Check the amount." });
      return z.NEVER;
    }
    return paiseToDecimalString(r.paise);
  });

const requiredFee = feeOrNull.refine((v) => v !== null, { error: "Enter the agreed fee (excl. GST)." });

const frequency = z.enum(SERVICE_FREQUENCIES, { error: "Choose the filing frequency." });

/** "Same as filing" in a select (which can't hold an empty value); stored as null (§5.3). */
export const BILLING_SAME = "same";

const billingFrequency = z
  .union([z.enum(SERVICE_FREQUENCIES), z.literal(BILLING_SAME), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v && v !== BILLING_SAME ? v : null));

const reason = z
  .string()
  .trim()
  .min(3, { error: "Give a reason (at least 3 characters)." })
  .max(SERVICE_LIMITS.reason, { error: `Keep the reason under ${SERVICE_LIMITS.reason} characters.` });

/** Terms shared by add and edit. */
const termsShape = {
  frequency,
  nextDueDate: dateOrNull("next due date"),
  billingFrequency,
  sacCode,
  autoInvoice: z.boolean().default(false),
  nextBillingDate: dateOrNull("next billing date"),
};

type TermsOut = {
  frequency: ServiceFrequency;
  billingFrequency: ServiceFrequency | null;
  autoInvoice: boolean;
  nextBillingDate: string | null;
};

/** Raising invoices automatically needs a recurring cycle and a first billing date (§7.3.2 step 3, §7.9.6). */
function checkTerms(v: TermsOut, ctx: z.RefinementCtx, agreedFee: string | null | undefined) {
  const cycle = v.billingFrequency ?? v.frequency;
  if (v.autoInvoice) {
    if (cycle === "one_time") {
      ctx.addIssue({ code: "custom", path: ["autoInvoice"], message: "A one-time service isn't billed automatically. Raise its invoice by hand." });
    }
    if (!v.nextBillingDate) {
      ctx.addIssue({ code: "custom", path: ["nextBillingDate"], message: "Choose the date of the first automatic invoice." });
    }
    if (agreedFee === null) {
      ctx.addIssue({ code: "custom", path: ["autoInvoice"], message: "Agree a fee first: automatic invoices bill the agreed fee." });
    }
  }
}

export const AddServiceSchema = z
  .object({
    clientId: uuid("client"),
    serviceType: z.enum(SERVICE_TYPES, { error: "Choose the service." }),
    customName: z
      .string()
      .trim()
      .max(SERVICE_LIMITS.customName, { error: `Keep the name under ${SERVICE_LIMITS.customName} characters.` })
      .nullish()
      .transform((v) => (v ? v : null)),
    ...termsShape,
    agreedFee: feeOrNull,
    /** When the fee was agreed (fee_agreed_at); today when empty. */
    feeAgreedOn: dateOrNull("date the fee was agreed"),
  })
  .superRefine((v, ctx) => {
    if (v.serviceType === "other" && !v.customName) {
      ctx.addIssue({ code: "custom", path: ["customName"], message: "Name the service." });
    }
    checkTerms(v, ctx, v.agreedFee);
  });
export type AddServiceInput = z.input<typeof AddServiceSchema>;
export type AddServiceValues = z.output<typeof AddServiceSchema>;

export const UpdateServiceSchema = z
  .object({
    id: uuid("service"),
    clientId: uuid("client"),
    updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
    /** The fee as loaded (for the auto-invoice check only; the fee changes through Re-price). */
    hasAgreedFee: z.boolean().default(false),
    ...termsShape,
  })
  .superRefine((v, ctx) => checkTerms(v, ctx, v.hasAgreedFee ? "set" : null));
export type UpdateServiceInput = z.input<typeof UpdateServiceSchema>;

export const RepriceServiceSchema = z.object({
  id: uuid("service"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
  agreedFee: requiredFee,
  /** fee_agreed_at (§7.3.3 "re-pricing records fee_agreed_at"); not in the future. */
  feeAgreedOn: dateOrNull("date the new fee was agreed").refine((v) => v !== null, { error: "Enter the date the new fee was agreed." }),
  note: z
    .string()
    .trim()
    .max(SERVICE_LIMITS.reason, { error: `Keep the note under ${SERVICE_LIMITS.reason} characters.` })
    .nullish()
    .transform((v) => (v ? v : null)),
});
export type RepriceServiceInput = z.input<typeof RepriceServiceSchema>;

export const EndServiceSchema = z.object({
  id: uuid("service"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
  endedOn: dateOrNull("date the service ended").refine((v) => v !== null, { error: "Enter the date the service ended." }),
  reason,
});
export type EndServiceInput = z.input<typeof EndServiceSchema>;

export const ResumeServiceSchema = z.object({
  id: uuid("service"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
});
export type ResumeServiceInput = z.input<typeof ResumeServiceSchema>;

/** "GST returns", or the custom name for Other ("Other: Trademark filing"). */
export function serviceName(serviceType: ServiceType | string, customName: string | null | undefined): string {
  if (serviceType === "other") return customName ? customName : SERVICE_TYPE_LABELS.other;
  const label = SERVICE_TYPE_LABELS[serviceType as ServiceType] ?? String(serviceType).replace(/_/g, " ");
  return customName ? `${label}: ${customName}` : label;
}

/** The billing cycle actually used: billing_frequency, or the filing frequency when it is empty. */
export function billingCycle(frequency: ServiceFrequency, billingFrequency: ServiceFrequency | null | undefined): ServiceFrequency {
  return billingFrequency ?? frequency;
}

/** "per month", "per quarter", "per year", "once" for a fee's billing cycle. */
export function perCycleLabel(cycle: ServiceFrequency): string {
  switch (cycle) {
    case "monthly":
      return "per month";
    case "quarterly":
      return "per quarter";
    case "annual":
      return "per year";
    case "one_time":
      return "once";
  }
}
