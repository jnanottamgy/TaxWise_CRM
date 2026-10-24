import Link from "next/link"
import { ChevronRightIcon, HandCoinsIcon, InboxIcon, UsersIcon } from "lucide-react"
import { formatDate } from "@/lib/format"
import { formatINR } from "@/lib/domain/money"
import { diffDays } from "@/lib/domain/fy"
import { reminderSlotLabel } from "@/lib/domain/collections"
import { MESSAGE_CHANNEL_LABEL } from "@/lib/handoff"
import type { PaymentsDashboard } from "@/lib/data/payments"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { PromiseChip } from "@/components/collections/ui"

/**
 * The lists on the payments dashboard (§7.9.5): the ten clients owing most, payment promises
 * falling due this month against what came in, and reminders waiting to be sent by hand. Server
 * components; each row opens what it is about.
 */

const rowLink =
  "flex min-h-11 items-center gap-3 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:relative focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"

export function TopDebtors({ rows, today }: { rows: PaymentsDashboard["topDebtors"]; today: string }) {
  return (
    <SectionCard title="Top 10 debtors" description="The clients owing most, with what is past its due date." flush viewAll={{ href: "/invoices?status=sent,partially_paid,disputed&sort=outstanding_amount&dir=desc", label: "All receivables" }}>
      {rows.length ? (
        <ol className="divide-y divide-border border-t border-border">
          {rows.map((d, i) => (
            <li key={d.clientId}>
              <Link href={`/invoices?client=${d.clientId}&status=sent,partially_paid,disputed`} className={rowLink}>
                <span className="num w-5 flex-none text-right text-sm text-text-muted tabular-nums">{i + 1}</span>
                {/* Name and amount share the first line; on phones the overdue figure gets its own line
                    instead of squeezing the name to a few letters. */}
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-base text-text">{d.clientName}</span>
                    <span className="num flex-none text-base font-medium text-text tabular-nums">{formatINR(d.outstandingPaise)}</span>
                  </span>
                  <span className="flex flex-col text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                    <span className="truncate text-text-muted" title={`Oldest unpaid invoice: ${formatDate(d.oldestIssueDate)}`}>
                      {d.clientCode} · {d.invoices} {d.invoices === 1 ? "invoice" : "invoices"} · oldest {diffDays(today, d.oldestIssueDate)} days ago
                    </span>
                    {d.overduePaise > 0 ? (
                      <span className="num flex-none text-danger-text tabular-nums">
                        {formatINR(d.overduePaise)} overdue{d.maxDaysOverdue > 0 ? ` · up to ${d.maxDaysOverdue} days` : ""}
                      </span>
                    ) : (
                      <span className="flex-none text-text-muted">Not yet due</span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" icon={<UsersIcon />} message="No client owes anything right now." />
        </div>
      )}
    </SectionCard>
  )
}

export function PromisesThisMonth({ p }: { p: PaymentsDashboard["promises"] }) {
  const month = formatDate(p.monthStart).slice(3)
  return (
    <SectionCard
      title="Promised and received"
      description={`Payment dates clients promised for ${month}, and what has come in against them.`}
      flush
    >
      <dl className="grid grid-cols-2 border-y border-border">
        <div className="px-4 py-3 md:px-5">
          <dt className="text-sm text-text-muted">Promised</dt>
          <dd className="num mt-0.5 text-xl font-semibold text-text tabular-nums">{formatINR(p.promisedPaise)}</dd>
          <dd className="text-sm text-text-muted">
            {p.count} {p.count === 1 ? "promise" : "promises"}
          </dd>
        </div>
        <div className="border-l border-border px-4 py-3 md:px-5">
          <dt className="text-sm text-text-muted">Received against them</dt>
          <dd className="num mt-0.5 text-xl font-semibold text-text tabular-nums">{formatINR(p.receivedPaise)}</dd>
          <dd className="text-sm text-text-muted">
            {p.kept} kept · {p.missed ? <span className="text-danger-text">{p.missed} missed</span> : "0 missed"} · {p.open} open
          </dd>
        </div>
      </dl>
      {p.rows.length ? (
        <ul className="divide-y divide-border">
          {p.rows.slice(0, 6).map((r) => (
            <li key={r.invoiceId}>
              <Link href={`/invoices/${r.invoiceId}#collections`} className={rowLink}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-text">{r.clientName}</span>
                  <span className="block truncate text-sm text-text-muted">
                    {r.invoiceNumber ?? "Invoice"} · by {formatDate(r.promisedOn)}
                  </span>
                </span>
                <span className="flex flex-none flex-col items-end gap-0.5">
                  <span className="num text-base text-text tabular-nums">{formatINR(r.promisedPaise)}</span>
                  <PromiseChip status={r.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-4 py-4 md:px-5">
          <EmptyState size="compact" icon={<HandCoinsIcon />} message={`No payment promised for ${month} yet. Log promises on an invoice's follow-up log.`} />
        </div>
      )}
    </SectionCard>
  )
}

export function HandoffQueue({ h }: { h: PaymentsDashboard["handoffs"] }) {
  if (!h.count) return null
  return (
    <SectionCard
      title="Reminders to send by hand"
      description={`${h.count} payment ${h.count === 1 ? "reminder" : "reminders"} couldn't go by email. Each has its WhatsApp and Gmail drafts ready on the invoice.`}
      flush
    >
      <ul className="divide-y divide-border border-t border-border">
        {h.rows.map((r) => (
          <li key={r.id}>
            <Link href={`/invoices/${r.invoiceId}#collections`} className={rowLink}>
              <InboxIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base text-text">
                  {r.clientName} · {r.invoiceNumber ?? "Invoice"}
                </span>
                <span className="block truncate text-sm text-text-muted">
                  {reminderSlotLabel(r.reminderKey)} · {MESSAGE_CHANNEL_LABEL[r.channel] ?? r.channel}
                  {r.ownerName ? ` · for ${r.ownerName}` : ""}
                </span>
              </span>
              <span className="num flex-none text-base text-text tabular-nums">{formatINR(r.outstandingPaise)}</span>
              <ChevronRightIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
