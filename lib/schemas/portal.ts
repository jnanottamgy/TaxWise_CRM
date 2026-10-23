import { z } from "zod";
import { compareDates, isDateString, isFinancialYear, todayIST } from "@/lib/domain/fy";
import { DEADLINE_PROGRESS } from "@/lib/domain/portal-copy";

/**
 * The client portal's inputs (§7.22), shared by its forms and server/actions/portal.ts, and the URL
 * state of its lists. Client-safe.
 *
 *   acknowledgePrivacyNotice(AcknowledgeNoticeInput)  /portal/welcome (§6.10)
 *   reportPayment(PaymentClaimInput)                  the Pay dialog's "I've paid"
 *   sendPortalMessage(PortalMessageInput)             Messages
 *   markPortalMessagesRead(MarkReadInput)             opening Messages (read receipts)
 */

// -------------------------------------------------------------------------------------------------
// Privacy notice (§6.10, §7.22 first sign-in)
// -------------------------------------------------------------------------------------------------

/**
 * What the portal user acknowledges the firm uses their personal data for (§6.10 consent_records
 * `purposes`), in the order the notice explains them.
 */
export const CONSENT_PURPOSES = [
  { key: "service_delivery", label: "Providing the services we're engaged for: income tax, GST, TDS, audit, accounting, payroll and company law work" },
  { key: "statutory_filings", label: "Filing returns and forms, and dealing with the authorities on your behalf" },
  { key: "legal_obligations", label: "Meeting our own legal and professional obligations as Chartered Accountants" },
  { key: "reminders_and_billing", label: "Reminding you about deadlines, documents and invoices, and billing for our work" },
  { key: "security", label: "Keeping our systems and your information secure, including sign-in records" },
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]["key"];
export const CONSENT_PURPOSE_KEYS: ConsentPurpose[] = CONSENT_PURPOSES.map((p) => p.key);

/** consent_records.channel for an acknowledgement made in the portal. */
export const CONSENT_CHANNEL = "portal";

export const AcknowledgeNoticeSchema = z.object({
  /** The version shown on the page; refused if a newer one has been published since. */
  noticeVersion: z.string().trim().min(1, { error: "The privacy notice version is missing. Reload the page." }).max(40),
  accepted: z.literal(true, { error: "Tick the box to confirm you've read the privacy notice." }),
});
export type AcknowledgeNoticeInput = z.input<typeof AcknowledgeNoticeSchema>;

// -------------------------------------------------------------------------------------------------
// "I've paid" (§7.22 Pay dialog)
// -------------------------------------------------------------------------------------------------

export const CLAIM_LIMITS = { reference: 100, note: 1000 } as const;

export const PaymentClaimSchema = z
  .object({
    invoiceId: z.uuid({ error: "That invoice isn't valid. Reload the page." }),
    reference: z
      .string({ error: "Enter the payment reference." })
      .trim()
      .min(1, { error: "Enter the payment reference: the UTR, UPI transaction ID or cheque number." })
      .max(CLAIM_LIMITS.reference, { error: `Keep the reference under ${CLAIM_LIMITS.reference} characters.` }),
    paidOn: z
      .string({ error: "Enter the date you paid." })
      .trim()
      .min(1, { error: "Enter the date you paid." })
      .refine((v) => isDateString(v), { error: "Enter the date you paid, for example 22 Oct 2026." }),
    note: z
      .string()
      .trim()
      .max(CLAIM_LIMITS.note, { error: "Keep the note under 1,000 characters." })
      .nullish()
      .transform((v) => (v ? v : null)),
    /** The screenshot's upload slot (requestUploadSlots, server/actions/documents.ts), when one is attached. */
    uploadId: z
      .union([z.uuid({ error: "The screenshot upload isn't valid. Attach it again." }), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (isDateString(v.paidOn) && compareDates(v.paidOn, todayIST()) > 0) {
      ctx.addIssue({ code: "custom", path: ["paidOn"], message: "The payment date can't be in the future." });
    }
  });
export type PaymentClaimInput = z.input<typeof PaymentClaimSchema>;

// -------------------------------------------------------------------------------------------------
// Messages (§7.22)
// -------------------------------------------------------------------------------------------------

export const MESSAGE_LIMITS = { body: 5000, attachments: 5 } as const;

export const PortalMessageSchema = z.object({
  body: z
    .string({ error: "Write your message." })
    .trim()
    .min(1, { error: "Write your message." })
    .max(MESSAGE_LIMITS.body, { error: `Keep the message under ${MESSAGE_LIMITS.body.toLocaleString("en-IN")} characters.` }),
  /** Upload slots of files to attach (requestUploadSlots); the action confirms them. */
  uploadIds: z
    .array(z.uuid({ error: "An attachment isn't valid. Attach it again." }))
    .max(MESSAGE_LIMITS.attachments, { error: `Attach at most ${MESSAGE_LIMITS.attachments} files to one message.` })
    .default([]),
});
export type PortalMessageInput = z.input<typeof PortalMessageSchema>;

export const MarkReadSchema = z.object({
  messageIds: z.array(z.uuid()).max(500).nullish().transform((v) => (v && v.length ? v : null)),
});
export type MarkReadInput = z.input<typeof MarkReadSchema>;

// -------------------------------------------------------------------------------------------------
// List state in the URL (§2.3: pagination, sort and filters happen in SQL)
// -------------------------------------------------------------------------------------------------

/** Invoices list (?show=…&fy=…). */
export const INVOICE_SHOW = ["due", "all", "paid"] as const;
export type InvoiceShow = (typeof INVOICE_SHOW)[number];
export const INVOICE_SORTS = ["issue_date", "due_date", "invoice_number", "total_amount", "outstanding_amount"] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];

/** Deadlines page (?view=open|overdue|all). */
export const DEADLINE_VIEWS = ["open", "overdue", "upcoming"] as const;
export type DeadlineView = (typeof DEADLINE_VIEWS)[number];

/** Compliance page (?group=…&progress=…). */
export const COMPLIANCE_GROUPS = ["gst", "income_tax", "tds", "roc", "payroll", "other"] as const;
export type ComplianceGroup = (typeof COMPLIANCE_GROUPS)[number];
export const COMPLIANCE_GROUP_LABEL: Record<ComplianceGroup, string> = {
  gst: "GST",
  income_tax: "Income tax",
  tds: "TDS",
  roc: "Company law (ROC)",
  payroll: "PF, ESIC and PT",
  other: "Other",
};
/** compliance_type values per group (§5.1). */
export const COMPLIANCE_GROUP_TYPES: Record<ComplianceGroup, string[]> = {
  gst: ["gstr_1", "gstr_3b"],
  income_tax: ["itr", "advance_tax", "audit"],
  tds: ["tds"],
  roc: ["roc"],
  payroll: ["pf_esic", "pt"],
  other: ["custom"],
};
export const COMPLIANCE_PROGRESS_FILTER = [...DEADLINE_PROGRESS, "overdue"] as const;
export const COMPLIANCE_SORTS = ["due_date", "form_code", "filed_on"] as const;

/** The FY a page shows: `?fy=` if valid, else the given default. */
export function resolveFy(value: string | null | undefined, fallback: string): string {
  return value && isFinancialYear(value) ? value : fallback;
}

/** Shared documents list: categories the firm shares (§7.22 "returns, computations, financial statements, engagement letter"). */
export const SHARED_SORTS = ["created_at", "title"] as const;

/** Rows per page on portal lists (the shared DataTable sizes: 25/50/100). */
export const PORTAL_PAGE_SIZE = 25;
