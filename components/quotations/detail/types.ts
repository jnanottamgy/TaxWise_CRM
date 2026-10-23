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
  email: string
  /** The client's link, absolute (/q/<token>). */
  link: string
  pdfHref: string
  actions: QuotationActions
  viewerRole: "partner" | "manager"
  emailReady: boolean
  /** Normalised WhatsApp digits, or null when there is no usable number. */
  whatsappNumber: string | null
  drafts: { whatsapp: string; emailSubject: string; emailBody: string }
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
  /** The hand-off drafts for this day. */
  whatsapp: string
  emailSubject: string
  emailBody: string
}
