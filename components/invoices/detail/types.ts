import type { InvoiceStatus } from "@/lib/domain/enums"
import type { StatutoryParameterRow, GstParams } from "@/lib/domain/gst"
import type { Paise } from "@/lib/domain/money"

/**
 * What the invoice page (§7.9.3) hands its client components. Plain data, so it crosses the
 * server/client boundary. Partners and Managers only: nothing here is ever built for an Employee.
 */

export type DetailInvoice = {
  id: string
  updatedAt: string
  number: string | null
  kind: "tax_invoice" | "debit_note"
  status: InvoiceStatus
  cancelled: boolean
  clientId: string
  clientName: string
  issueDate: string
  dueDate: string
  periodLabel: string | null
  totalPaise: Paise
  outstandingPaise: Paise
  taxablePaise: Paise
  placeOfSupplyCode: string
  eInvoice: { irn: string | null; ackNo: string | null; ackDate: string | null; signedQr: string | null }
}

export type SendRecipient = {
  contactId: string | null
  name: string
  phone: string | null
  whatsapp: string | null
  primary: boolean
}

export type SendTemplate = { id: string; name: string; body: string; channel: string }

/** Everything a WhatsApp send from the invoice page needs: who, the number, the links, the templates. */
export type SendContext = {
  recipients: SendRecipient[]
  client: { phone: string | null; whatsapp: string | null }
  portalUrl: string
  upi: { id: string; payee: string } | null
  firmName: string
  firmPhone: string | null
  countryCode: string
  signatureFormat: string
  addSignature: boolean
  senderName: string
  /** Money templates (payment reminders) and custom ones, unrendered. */
  templates: SendTemplate[]
}

export type ReceiptContext = {
  taxablePaise: Paise
  /** TDS already on the invoice's live receipts. */
  tdsAlreadyPaise: Paise
  /** Every TDS parameter row up to today; the form picks the rules in force on the payment date. */
  tdsRows: StatutoryParameterRow[]
  clientHasTan: boolean
  defaultDepositedTo: string
  today: string
}

export type CreditContext = {
  items: Array<{ amount: number; tax_rate: number; is_reimbursement: boolean }>
  creditNotes: Array<{ taxable_amount: number; tax_rate: number | null; reduces_gst: boolean }>
  firmStateCode: string
  annualReturnFiledOn: string | null
  params: Pick<GstParams, "creditNoteDeadline" | "creditNoteWarnDays">
  fy: string
  today: string
}

export type PendingClaim = { id: string; reference: string | null; paidOn: string | null; note: string | null; createdAt: string; updatedAt: string; screenshotDocumentId: string | null }
