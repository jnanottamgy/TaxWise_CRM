import type { ClientBillingFacts } from "@/lib/data/invoices"
import type { InvoiceFormInput } from "@/lib/schemas/invoices"
import type { RateOption } from "@/lib/domain/gst"

/** What the editor page hands the editor (§7.9.2). Plain data, so it crosses the server/client boundary. */
export type EditorInvoice = {
  id: string
  status: "draft" | "awaiting_approval"
  invoiceKind: "tax_invoice" | "debit_note"
  requiresApproval: boolean
  approvedAt: string | null
  approvedByName: string | null
  approvalNote: string | null
  returnedAt: string | null
  returnedByName: string | null
  submittedAt: string | null
  createdByName: string | null
  revisedFrom: { id: string; number: string | null } | null
  original: { id: string; number: string | null } | null
}

export type EditorSettings = {
  firmStateCode: string
  defaultSac: string
  sacByService: Record<string, string>
  paymentTermsDays: number
  invoiceTerms: string | null
  /** In paise; null = no approvals needed. */
  approvalLimitPaise: number | null
  roundOffDefault: boolean
}

export type EditorGst = {
  rateOptions: RateOption[]
  defaultRate: number
  b2cThresholdPaise: number
  b2cInclusive: boolean
  invoiceIssueDays: number
  unbilledFlagDays: number
}

export type EditorProps = {
  mode: "new" | "edit"
  initial: InvoiceFormInput
  invoice: EditorInvoice | null
  client: ClientBillingFacts | null
  settings: EditorSettings
  gst: EditorGst
  viewer: { role: "partner" | "manager"; name: string }
  today: string
}
