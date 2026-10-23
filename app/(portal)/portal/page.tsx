import type { Metadata } from "next"
import Link from "next/link"
import { FileTextIcon, IndianRupeeIcon, MessageSquareIcon } from "lucide-react"
import { requireClient } from "@/lib/auth/guards"
import { todayIST } from "@/lib/domain/fy"
import { formatDate, formatTimeAgo } from "@/lib/format"
import { formatINR, fromPaise } from "@/lib/domain/money"
import { explainDeadline, homeSummary, invoiceStatus, outstandingItemCount } from "@/lib/domain/portal-copy"
import {
  getDeadlineCounts,
  getFirmContact,
  getInvoiceSummary,
  getLatestFromFirm,
  getNextDeadlines,
  getPortalClient,
  listRequests,
  payDetailsOf,
  withUpi,
} from "@/lib/data/portal"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { StatusChip } from "@/components/app/status-chip"
import { attempt } from "@/components/portal/load"
import { NotLinked, PortalBlockError, RowLink, moreLink } from "@/components/portal/portal-ui"
import { DeadlineList } from "@/components/portal/deadline-list"
import { ContactCard } from "@/components/portal/contact-card"
import { PayButton } from "@/components/portal/pay-dialog"

export const metadata: Metadata = { title: "Home" }

const DEADLINES = 4
const INVOICES = 3
const MESSAGES = 3

/**
 * Portal home (§7.22): "What do I need to do, and what's due?" The next deadlines with what we need
 * from the client, the documents we've asked for, outstanding invoices with Pay, the firm's latest
 * messages and the contact card with the owner's name. Every block loads on its own and fails on
 * its own (§0.1 rule 3). Read under the client's session through the portal views only.
 */
export default async function PortalHomePage() {
  const { user, supabase } = await requireClient()
  const today = todayIST()

  const client = await attempt("home:client", user.id, () => getPortalClient(supabase))
  if (client.ok && !client.data) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Home" />
        <NotLinked />
      </div>
    )
  }
  const clientId = client.ok && client.data ? client.data.id : null

  const [deadlines, counts, requests, invoices, messages, firm] = await Promise.all([
    attempt("home:deadlines", user.id, () => getNextDeadlines(supabase, DEADLINES)),
    attempt("home:counts", user.id, () => getDeadlineCounts(supabase, today)),
    attempt("home:requests", user.id, () => listRequests(supabase, { completedLimit: 0 })),
    attempt("home:invoices", user.id, () => getInvoiceSummary(supabase, INVOICES)),
    attempt("home:messages", user.id, () => getLatestFromFirm(supabase, MESSAGES)),
    attempt("home:firm", user.id, () => getFirmContact(supabase)),
  ])

  const details = firm.ok ? payDetailsOf(firm.data) : null
  const dueRows = !invoices.ok ? [] : details ? await withUpi(details, invoices.data.due) : invoices.data.due.map((inv) => ({ ...inv, upi: null }))
  const openRequests = requests.ok ? requests.data.open : []
  const toUpload = openRequests.reduce((n, r) => n + outstandingItemCount(r.items), 0)
  const next = deadlines.ok ? deadlines.data[0] : undefined
  const nextLine = next ? `${explainDeadline({ formCode: next.formCode, type: next.type, filingPeriod: next.filingPeriod, title: next.title }).headline}, due ${formatDate(next.dueDate)}` : null
  const summary = homeSummary({
    overdue: counts.ok ? counts.data.overdue : 0,
    toUpload,
    due: invoices.ok && invoices.data.outstandingPaise > 0 ? formatINR(invoices.data.outstandingPaise) : null,
    unread: messages.ok ? messages.data.unread : 0,
    next: nextLine,
  })

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader title="Home" description={summary} />

      <KpiStrip
        aria-label="What needs you"
        className="mb-4 md:mb-6"
        items={[
          {
            label: "Next deadline",
            value: next ? <DateText date={next.dueDate} /> : <span className="text-text-muted">—</span>,
            sub: next ? explainDeadline({ formCode: next.formCode, type: next.type, filingPeriod: next.filingPeriod, title: next.title }).headline : "Nothing planned",
            href: "/portal/deadlines",
          },
          {
            label: "Documents to upload",
            value: requests.ok ? toUpload : <span className="text-text-muted">—</span>,
            sub: requests.ok ? (openRequests.length ? `${openRequests.length} ${openRequests.length === 1 ? "request" : "requests"} open` : "Nothing asked for") : "Couldn't load",
            href: "/portal/documents",
          },
          {
            label: "Amount due",
            value: invoices.ok ? <Money value={fromPaise(invoices.data.outstandingPaise)} /> : <span className="text-text-muted">—</span>,
            sub: invoices.ok ? (invoices.data.overdueCount ? `${invoices.data.overdueCount} overdue` : invoices.data.dueCount ? `${invoices.data.dueCount} ${invoices.data.dueCount === 1 ? "invoice" : "invoices"}` : "All paid") : "Couldn't load",
            href: "/portal/invoices",
          },
          {
            label: "New messages",
            value: messages.ok ? messages.data.unread : <span className="text-text-muted">—</span>,
            sub: "From the firm",
            href: "/portal/messages",
          },
        ]}
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 lg:gap-6">
          {!deadlines.ok ? (
            <PortalBlockError title="Next deadlines" message="Couldn't load your deadlines." errorRef={deadlines.ref} />
          ) : (
            <SectionCard
              title="Next deadlines"
              description={counts.ok && counts.data.overdue > 0 ? `${counts.data.overdue} overdue` : "What's coming up, and what we need from you"}
              viewAll={counts.ok ? moreLink("/portal/deadlines", counts.data.overdue + counts.data.upcoming, deadlines.data.length) ?? { href: "/portal/deadlines", label: "All deadlines" } : { href: "/portal/deadlines", label: "All deadlines" }}
            >
              <DeadlineList rows={deadlines.data} today={today} showNeeds="all" compact emptyMessage="No deadlines coming up. We'll add them as your services start." />
            </SectionCard>
          )}

          {!requests.ok ? (
            <PortalBlockError title="Documents we've asked for" message="Couldn't load your document requests." errorRef={requests.ref} />
          ) : (
            <SectionCard title="Documents we've asked for" description={openRequests.length ? `${toUpload} still to upload` : undefined} viewAll={openRequests.length ? { href: "/portal/documents", label: "Upload documents" } : undefined}>
              {openRequests.length === 0 ? (
                <EmptyState size="compact" icon={<FileTextIcon />} message="Nothing to upload right now." />
              ) : (
                <ul className="divide-y divide-border/70">
                  {openRequests.slice(0, 4).map((r) => {
                    const left = outstandingItemCount(r.items)
                    const rejected = r.items.filter((i) => i.status === "rejected").length
                    return (
                      <li key={r.id} className="flex min-h-11 flex-col justify-center gap-0.5 py-2.5">
                        <div className="flex items-start justify-between gap-3">
                          <RowLink href={`/portal/documents#req-${r.id}`}>{r.title}</RowLink>
                          <span className="num flex-none text-sm text-text-muted tabular-nums">
                            {left} of {r.items.length} to upload
                          </span>
                        </div>
                        <p className="flex flex-wrap gap-x-1.5 text-sm text-text-muted">
                          {r.dueDate ? (
                            <span>
                              Needed by <DateText date={r.dueDate} withRelative={left > 0} today={today} />
                            </span>
                          ) : null}
                          {rejected > 0 ? <span className="text-danger-text">· {rejected === 1 ? "1 file to upload again" : `${rejected} files to upload again`}</span> : null}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
            </SectionCard>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          {!invoices.ok ? (
            <PortalBlockError title="Invoices due" message="Couldn't load your invoices." errorRef={invoices.ref} />
          ) : (
            <SectionCard
              title="Invoices due"
              action={invoices.data.outstandingPaise > 0 ? <Money value={fromPaise(invoices.data.outstandingPaise)} className="text-base font-semibold text-text" /> : undefined}
              viewAll={{ href: "/portal/invoices", label: invoices.data.dueCount > INVOICES ? `All ${invoices.data.dueCount} invoices due` : "All invoices" }}
            >
              {dueRows.length === 0 ? (
                <EmptyState size="compact" icon={<IndianRupeeIcon />} message="Nothing is due. Thank you." />
              ) : (
                <ul className="divide-y divide-border/70">
                  {dueRows.map((inv) => {
                    const s = invoiceStatus(inv.displayStatus)
                    return (
                      <li key={inv.id} className="flex flex-col gap-1.5 py-3 first:pt-1 last:pb-1">
                        <div className="flex items-start justify-between gap-3">
                          <a href={`/api/portal/invoices/${inv.id}/pdf`} target="_blank" rel="noopener" className="num min-w-0 truncate text-base font-medium text-text tabular-nums hover:underline">
                            {inv.invoiceNumber}
                          </a>
                          <Money value={inv.outstanding} className="text-base font-medium text-text" />
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
                            <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} />
                            <span>
                              · due <DateText date={inv.dueDate} withRelative today={today} />
                            </span>
                          </p>
                          {details && clientId ? (
                            <PayButton
                              invoice={{ id: inv.id, invoiceNumber: inv.invoiceNumber, outstanding: inv.outstanding, dueDate: inv.dueDate, isOverdue: inv.isOverdue, pendingClaim: inv.pendingClaim }}
                              details={details}
                              upi={inv.upi}
                              clientId={clientId}
                              today={today}
                              variant="outline"
                            />
                          ) : null}
                        </div>
                        {inv.pendingClaim ? <p className="text-sm text-text-muted">You told us you&apos;ve paid. We&apos;ll confirm once it reaches our account.</p> : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </SectionCard>
          )}

          {!messages.ok ? (
            <PortalBlockError title="Latest messages from us" message="Couldn't load your messages." errorRef={messages.ref} />
          ) : (
            <SectionCard
              title="Latest messages from us"
              description={messages.data.unread ? `${messages.data.unread} new` : undefined}
              viewAll={{ href: "/portal/messages", label: messages.data.messages.length ? "Open messages" : "Write to us" }}
            >
              {messages.data.messages.length === 0 ? (
                <EmptyState size="compact" icon={<MessageSquareIcon />} message="No messages yet." />
              ) : (
                <ul className="divide-y divide-border/70">
                  {messages.data.messages.map((m) => (
                    <li key={m.id} className="flex flex-col gap-0.5 py-2.5 first:pt-1 last:pb-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <Link href="/portal/messages" className="min-w-0 truncate text-base font-medium text-text hover:underline">
                          {m.senderName ?? (firm.ok ? firm.data.firmName : "The firm")}
                        </Link>
                        <span className="flex-none text-xs text-text-muted">{formatTimeAgo(m.sentAt ?? m.createdAt)}</span>
                      </div>
                      <p className="line-clamp-2 text-sm text-text-muted">
                        {!m.readAt ? <span className="mr-1 font-medium text-text">New ·</span> : null}
                        {m.subject ? `${m.subject}: ` : ""}
                        {m.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          )}

          {firm.ok ? (
            <ContactCard owner={client.ok && client.data ? client.data.owner : null} firm={firm.data} />
          ) : (
            <PortalBlockError title="Your contact at the firm" message="Couldn't load the firm's contact details." errorRef={firm.ref} />
          )}
        </div>
      </div>
    </div>
  )
}
