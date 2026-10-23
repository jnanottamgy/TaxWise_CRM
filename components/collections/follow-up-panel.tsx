import { unstable_rethrow } from "next/navigation"
import { getSession, type CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { formatDate } from "@/lib/format"
import { compareDates, diffDays, todayIST } from "@/lib/domain/fy"
import { formatINR } from "@/lib/domain/money"
import { applySignature, firstNameOf, pickWhatsAppNumber, upiPayUrl } from "@/lib/domain/messaging"
import { renderTemplate } from "@/lib/domain/templates"
import { defaultReminderDraft, pickReminderTemplate } from "@/lib/domain/collections"
import { getInvoiceCollections, type CollectionsContact } from "@/lib/data/collections"
import { getMessagingContext } from "@/lib/data/clients"
import { getFirmProfile } from "@/server/firm"
import { SectionCard } from "@/components/app/section-card"
import { BlockError } from "@/components/collections/ui"
import { FollowUpPanelBody, type PendingReminderView } from "@/components/collections/follow-up-panel-body"

/**
 * The collections panel for one invoice (§7.9.5), for the invoice page to embed:
 *
 *   <InvoiceFollowUpPanel invoiceId={invoice.id} />
 *
 * The follow-up log (channel, notes, promised payment date, next follow-up) with "Log follow-up",
 * the latest promise and whether it was kept, the payment reminders the daily job sent, and any it
 * couldn't email, waiting as hand-off tasks with the WhatsApp and Gmail drafts ready. Partners and
 * Managers only: anyone else gets nothing (and RLS returns nothing anyway). Its section is
 * `#collections`, which the job's notifications link to. Never throws: a failed load shows in the
 * panel with its Ref.
 */
export async function InvoiceFollowUpPanel({ invoiceId }: { invoiceId: string }) {
  const session = await getSession()
  if (session.status !== "ok" || (session.user.role !== "partner" && session.user.role !== "manager")) return null
  const { user, supabase } = session
  let view: PanelView | null = null
  let ref: string | null = null
  try {
    view = await loadPanelView(supabase, user, invoiceId)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "component:InvoiceFollowUpPanel", userId: user.id, invoiceId })
  }
  if (ref) return <BlockError title="Collections" message="Couldn't load the follow-ups and reminders for this invoice." errorRef={ref} />
  if (!view) return null
  const { inv, issued, open, today, data, pending, nextFollowUp } = view
  return (
    <SectionCard
      id="collections"
      title="Collections"
      description={
        !issued
          ? "Follow-ups and reminders start once the invoice is issued."
          : open
            ? `${formatINR(inv.outstandingPaise)} outstanding · reminders go 3 days before the due date, then 1, 7 and 15 days after.`
            : "Nothing is being collected on this invoice now; its history stays here."
      }
    >
      <FollowUpPanelBody
        invoiceId={inv.id}
        invoiceNumber={inv.number}
        canLog={issued && !inv.cancelled}
        clientOnHold={inv.clientStatus === "on_hold"}
        disputed={inv.status === "disputed"}
        today={today}
        promise={data.promise}
        nextFollowUp={nextFollowUp}
        followUps={data.followUps}
        reminders={data.reminders.filter((r) => r.status !== "handoff_pending")}
        pending={pending}
        pdfHref={`/api/pdf/invoice/${inv.id}?download=1`}
      />
    </SectionCard>
  )
}

type PanelView = NonNullable<Awaited<ReturnType<typeof loadPanelView>>>

async function loadPanelView(supabase: ServerSupabase, user: CurrentUser, invoiceId: string) {
  const [data, messaging, firm] = await Promise.all([getInvoiceCollections(supabase, invoiceId), getMessagingContext(supabase, user), getFirmProfile(supabase)])
  if (!data) return null
  const today = todayIST()
  const inv = data.invoice
  const issued = Boolean(inv.number) && inv.status !== "draft" && inv.status !== "awaiting_approval"
  const open = issued && !inv.cancelled && (inv.status === "sent" || inv.status === "partially_paid" || inv.status === "disputed")

  const portalUrl = `${env.appUrl().replace(/\/+$/, "")}/portal/invoices/${inv.id}`
  let upiLink: string | null = null
  if (firm.upi && inv.outstandingPaise > 0 && inv.number) {
    try {
      upiLink = upiPayUrl({ upiId: firm.upi.id, payee: firm.upi.payeeName, amountPaise: inv.outstandingPaise, note: `Invoice ${inv.number}` })
    } catch {
      upiLink = null
    }
  }
  const billing: CollectionsContact | null = data.contacts.find((c) => c.primary) ?? data.contacts[0] ?? null
  const sign = (text: string) => (messaging.addSignature ? applySignature(text, messaging.signatureFormat, firstNameOf(user.fullName)) : text)

  const pending: PendingReminderView[] = data.reminders
    .filter((r) => r.status === "handoff_pending")
    .map((r) => {
      const stage: "before" | "after" = r.kind === "before_due" ? "before" : "after"
      const days = stage === "before" ? Math.max(diffDays(inv.dueDate, today), 0) : Math.max(diffDays(today, inv.dueDate), 1)
      const contactName = billing ? firstNameOf(billing.name) || billing.name : null
      const values = {
        client_name: inv.clientName,
        contact_name: contactName ?? "",
        invoice_number: inv.number ?? "",
        amount: formatINR(inv.outstandingPaise),
        due_date: formatDate(inv.dueDate),
        days_overdue: stage === "after" ? days : "",
        days_until_due: stage === "before" ? days : "",
        payment_link: portalUrl,
        portal_link: portalUrl,
        upi_link: upiLink ?? "",
        firm_name: messaging.firmName,
        firm_phone: messaging.firmPhone ?? "",
        sender_name: user.fullName,
      }
      const fallback = defaultReminderDraft({
        contactName,
        invoiceNumber: inv.number ?? "",
        amount: formatINR(inv.outstandingPaise),
        dueDate: formatDate(inv.dueDate),
        stage,
        days,
        payLink: portalUrl,
        upiLink,
        firmName: messaging.firmName,
      })
      const wa = pickReminderTemplate(messaging.templates, "whatsapp", stage)
      const em = pickReminderTemplate(messaging.templates, "email", stage)
      const number = pickWhatsAppNumber(billing, { whatsapp: inv.clientWhatsapp, phone: inv.clientPhone }, { countryCode: messaging.countryCode })
      const email = data.contacts.find((c) => c.email && !c.bounced)?.email ?? inv.clientEmail
      return {
        id: r.id,
        key: r.reminderKey,
        reason: r.error,
        ownerName: r.ownerName,
        createdAt: r.createdAt,
        contactId: billing?.id ?? null,
        contactName: billing?.name ?? inv.clientName,
        whatsappNumber: number?.digits ?? null,
        whatsappTemplateId: wa?.id ?? null,
        whatsappDraft: sign(wa ? renderTemplate(wa.body, values) : fallback.body),
        email: email ?? null,
        emailTemplateId: em?.id ?? null,
        emailSubject: em?.subject ? renderTemplate(em.subject, values) : fallback.subject,
        emailBody: em ? renderTemplate(em.body, values) : fallback.body,
      }
    })

  const latestNext = data.followUps.find((f) => f.nextFollowUpAt)?.nextFollowUpAt ?? null
  const nextFollowUp = latestNext && compareDates(latestNext.slice(0, 10), today) >= 0 ? latestNext : null
  return { inv, issued, open, today, data, pending, nextFollowUp }
}
