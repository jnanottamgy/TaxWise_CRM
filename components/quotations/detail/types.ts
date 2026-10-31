import type { QuotationStatus } from "@/lib/domain/enums"
import type { QuotationActions } from "@/lib/schemas/quotations"

/** What the quotation page's controls need (built on the server page, passed to the client parts). */
export type ControlsData = {
  id: string
  number: string
  status: QuotationStatus
  displayStatus: QuotationStatus
  updatedAt: string
  /** The person it is addressed to. */
  recipientName: string
  /** The company, else the person: "for Sharma Traders". */
  who: string
  /** The client's link, absolute (/q/<token>). */
  link: string
  pdfHref: string
  /** The PDF that downloads as WhatsApp opens: "Quotation TW-Q-26-27-0007.pdf". */
  attachment: { href: string; filename: string }
  actions: QuotationActions
  viewerRole: "partner" | "manager"
  /** Normalised WhatsApp digits, or null when there is no usable number. */
  whatsappNumber: string | null
  /** The suggested WhatsApp message (signed), and the firm's Quotation templates filled in. */
  drafts: { whatsapp: string; templates: Array<{ id: string; name: string; body: string }> }
  createClientHref: string | null
  approval: { requestedAt: string | null; requestedByName: string | null } | null
  /** "₹56,050.54". */
  totalLabel: string
  validUntil: string
}

/** One follow-up as the follow-ups panel shows it. */
export type FollowUpView = {
  id: string
  day: number
  scheduledAt: string
  status: string
  sentAt: string | null
  channel: string | null
  /** The WhatsApp draft for this day. */
  whatsapp: string
}
