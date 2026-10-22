/**
 * Approval gates for invoices and quotations (§4.1, §5.2, §7.5.2, §7.9.2).
 *
 * - **Invoices:** a Manager-raised invoice whose total (incl. GST) exceeds
 *   `firm_settings.invoice_approval_limit` saves as Awaiting approval. A null limit means no
 *   approvals are needed. The gate is **frozen at creation** (`invoices.requires_approval`): a later
 *   change to the limit neither re-gates nor releases an invoice.
 * - **Quotations:** a Manager's quotation whose total exceeds `quotation_approval_limit` needs a
 *   Partner's approval before it can be sent. A null limit means Managers' quotations **always**
 *   need approval; a limit of 0 means **never**. Partners' own quotations skip approval.
 * - Only Partners approve (§4.1).
 *
 * Pure and client-safe. Amounts are integer paise; the caller converts the `numeric(14,2)` limits
 * with `toPaiseOrNull`.
 */

import type { AppRole, InvoiceStatus, QuotationStatus } from "@/lib/domain/enums";
import type { Paise } from "@/lib/domain/money";

/**
 * True when a new invoice must wait for a Partner (§7.9.2): never for a Partner; for a Manager when
 * a limit is set and the total incl. GST exceeds it; a null limit means no approvals. Employees and
 * clients can't raise invoices at all (refused by role and RLS); if asked, the answer is "held".
 * Call it once, at creation, and store the answer in `requires_approval`.
 */
export function invoiceNeedsApproval(creatorRole: AppRole, totalPaise: Paise, limitPaise: Paise | null): boolean {
  if (creatorRole === "partner") return false;
  if (creatorRole !== "manager") return true;
  if (limitPaise === null) return false;
  return totalPaise > limitPaise;
}

/** The status a new invoice saves with (§7.9.2): Awaiting approval when gated, otherwise Draft. */
export function initialInvoiceStatus(requiresApproval: boolean): Extract<InvoiceStatus, "draft" | "awaiting_approval"> {
  return requiresApproval ? "awaiting_approval" : "draft";
}

/**
 * True when a quotation needs a Partner's approval before it is sent (§7.5.2, §5.2): never for a
 * Partner; for a Manager, always when the limit is null, never when it is 0, otherwise when the
 * total exceeds it. Employees and clients can't create quotations; if asked, the answer is "held".
 */
export function quotationNeedsApproval(creatorRole: AppRole, totalPaise: Paise, limitPaise: Paise | null): boolean {
  if (creatorRole === "partner") return false;
  if (creatorRole !== "manager") return true;
  if (limitPaise === null) return true;
  if (limitPaise === 0) return false;
  return totalPaise > limitPaise;
}

/** Only Partners approve held invoices and quotations (§4.1). */
export function canApprove(role: AppRole): boolean {
  return role === "partner";
}

export type SendCheck = { ok: true } | { ok: false; error: string };

/**
 * Whether an invoice may be sent (§7.9.2, §7.9.3): an invoice awaiting approval can't be sent, nor
 * one gated at creation that no Partner has approved. Draft and Sent/Partially paid invoices can
 * be (re)sent; Paid, Waived and Disputed ones aren't sent again from here.
 */
export function canSendInvoice(input: { status: InvoiceStatus; requiresApproval: boolean; approvedAt: string | null }): SendCheck {
  if (input.status === "awaiting_approval" || (input.requiresApproval && !input.approvedAt)) {
    return { ok: false, error: "This invoice is over the approval limit and waits for a Partner's approval before it can be sent." };
  }
  if (input.status === "paid" || input.status === "waived") {
    return { ok: false, error: `This invoice is ${input.status}; there's nothing to send.` };
  }
  if (input.status === "disputed") return { ok: false, error: "This invoice is disputed. Resolve the dispute before sending it again." };
  return { ok: true };
}

/**
 * Whether a quotation may be sent to the client (§4.1, §7.5.2): a Partner may send their own; a
 * Manager's quotation that needs approval may be sent only once it is Approved. Superseded,
 * accepted, rejected and expired quotations are never sent.
 */
export function canSendQuotation(input: { status: QuotationStatus; needsApproval: boolean }): SendCheck {
  switch (input.status) {
    case "pending_approval":
      return { ok: false, error: "This quotation waits for a Partner's approval before it can be sent." };
    case "superseded":
    case "accepted":
    case "rejected":
    case "expired":
      return { ok: false, error: `This quotation is ${input.status}. Revise it to send a new version.` };
    case "draft":
      return input.needsApproval
        ? { ok: false, error: "This quotation is over the quotation approval limit. Submit it for a Partner's approval first." }
        : { ok: true };
    case "approved":
    case "sent":
    case "viewed":
      return { ok: true };
  }
}
