import Link from "next/link"
import { cn } from "@/lib/utils"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { StatusChip } from "@/components/app/status-chip"
import { formatTimeAgo } from "@/lib/format"
import type { DeadlineRow, UnreadMessageRow } from "@/lib/data/dashboard"
import { deadlineHref } from "@/components/home/logic"
import { MetaLine } from "@/components/tasks/meta-line"

/**
 * Pieces shared by My day, Team today and Firm today (§7.2). Server-safe; StatusChip and ErrorBlock
 * are client islands inside them.
 */

/** A block that failed to load: its own card, one sentence, the Ref and Retry (§0.1 rule 3). */
export function BlockError({ title, message, errorRef, className }: { title: string; message: string; errorRef: string; className?: string }) {
  return (
    <SectionCard title={title} className={className}>
      <ErrorBlock message={message} errorRef={errorRef} size="compact" className="px-0" />
    </SectionCard>
  )
}

/** A link styled as a row title (16px hit area doubled on touch). */
export function RowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("min-w-0 truncate rounded-sm text-base font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}
    >
      {children}
    </Link>
  )
}

/** "View all 18" when there are more than are shown. */
export function moreLink(href: string, total: number, shown: number, label = "View all"): { href: string; label: string } | undefined {
  return total > shown ? { href, label: `${label} ${total.toLocaleString("en-IN")}` } : undefined
}

/** The deadline's name as the filings grid shows it: "GSTR-3B · Sep 2026", or its title. */
export function deadlineName(d: Pick<DeadlineRow, "form_code" | "title" | "filing_period">): string {
  const name = d.form_code?.trim() || d.title
  return d.filing_period && !name.includes(d.filing_period) ? `${name} · ${d.filing_period}` : name
}

/**
 * Deadlines as rows (§7.7): the return and period, the client, the due date with its urgency (not
 * once filed) and the workflow status. Each opens the deadline in the calendar.
 */
export function DeadlineList({ rows, today, showClient = true, emptyMessage, className }: { rows: DeadlineRow[]; today: string; showClient?: boolean; emptyMessage: string; className?: string }) {
  if (rows.length === 0) return <EmptyState size="compact" message={emptyMessage} className={className} />
  return (
    <ul className={cn("divide-y divide-border/70", className)}>
      {rows.map((d) => {
        const open = d.status === "pending"
        return (
          <li key={d.id} className="flex min-h-11 flex-col justify-center gap-0.5 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <RowLink href={deadlineHref(d)}>{deadlineName(d)}</RowLink>
              <StatusChip kind="compliance_workflow" value={d.workflow_status} className="flex-none" />
            </div>
            <MetaLine>
              {showClient ? <span>{d.client_name ?? "Firm deadline"}</span> : null}
              <span className="whitespace-nowrap">
                <DateText date={d.due_date} withRelative={open} today={today} />
              </span>
            </MetaLine>
          </li>
        )
      })}
    </ul>
  )
}

/** Unread client messages: the client, the subject or first line, and when it came in. */
export function MessageList({ rows, emptyMessage }: { rows: UnreadMessageRow[]; emptyMessage: string }) {
  if (rows.length === 0) return <EmptyState size="compact" message={emptyMessage} />
  return (
    <ul className="divide-y divide-border/70">
      {rows.map((m) => (
        <li key={m.id} className="flex min-h-11 flex-col justify-center gap-0.5 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <RowLink href={`/clients/${m.client_id}?tab=communication`}>{m.client_name}</RowLink>
            <span className="num flex-none text-sm whitespace-nowrap text-text-muted">{formatTimeAgo(m.created_at)}</span>
          </div>
          <p className="line-clamp-2 text-sm text-text-muted">
            <span className="text-text">{m.channel === "portal" ? "Portal" : "Email"}</span>
            {m.subject ? ` · ${m.subject}` : ""}
            {m.snippet ? ` · ${m.snippet}` : ""}
          </p>
        </li>
      ))}
    </ul>
  )
}

/** A small labelled figure inside a card (not a KPI tile): label above, value, optional sub-line. */
export function Figure({ label, value, sub, href, className }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; href?: string; className?: string }) {
  const body = (
    <>
      <div className="text-sm text-text-muted">{label}</div>
      <div className="num mt-0.5 text-lg leading-7 font-semibold text-text tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 text-sm text-text-muted">{sub}</div> : null}
    </>
  )
  return href ? (
    <Link href={href} className={cn("block rounded-md p-2 -m-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring", className)}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}
