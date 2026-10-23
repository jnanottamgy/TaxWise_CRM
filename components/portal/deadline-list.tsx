import Link from "next/link"
import { CalendarClockIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { CopyButton } from "@/components/app/copy-button"
import { formatDate } from "@/lib/format"
import { deadlineStatus, explainDeadline, whatWeNeed } from "@/lib/domain/portal-copy"
import type { PortalDeadline } from "@/lib/data/portal"
import { PortalStatusChip } from "@/components/portal/portal-ui"

/**
 * Deadlines in plain language (§7.22 Deadlines and Home): "GSTR-3B for September 2026", what it is
 * ("your monthly GST summary return, where the tax for the month is paid"), the due date with its
 * urgency, where it stands, a government extension when one moved it, and, when asked, what we need
 * from the client. Server-safe.
 */

export type NeedsMode = "all" | "attention" | "none"

export function DeadlineItem({
  d,
  today,
  openRequestItems,
  showNeeds,
  compact = false,
}: {
  d: PortalDeadline
  today: string
  /** Titles of items still to upload on open document requests. */
  openRequestItems: readonly string[]
  /** `all`: every open deadline; `attention`: overdue, waiting for documents, or due within 7 days. */
  showNeeds: NeedsMode
  /** One line for "what we need" instead of a box (Home). */
  compact?: boolean
}) {
  const e = explainDeadline({ formCode: d.formCode, type: d.type, filingPeriod: d.filingPeriod, title: d.title })
  const status = deadlineStatus(d.progress, d.isOverdue)
  const open = d.status === "pending"
  const wanted = showNeeds === "all" || (showNeeds === "attention" && (d.isOverdue || d.progress === "waiting_on_you" || d.daysUntilDue <= 7))
  const need = wanted && open ? whatWeNeed({ progress: d.progress, formNeeds: e.needs, openRequestItems }) : null
  return (
    <li className="flex flex-col gap-1.5 py-3.5 first:pt-1 last:pb-1">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-semibold text-text">{e.headline}</h3>
        <PortalStatusChip status={status} />
      </div>
      {e.explanation ? <p className="text-base text-text-muted first-letter:uppercase">{e.explanation}.</p> : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-text-muted">
        <span>
          Due <DateText date={d.dueDate} withRelative={open} today={today} className="text-text" />
        </span>
        {d.isExtended && d.originalDueDate ? (
          <span>
            · extended from <span className="num tabular-nums">{formatDate(d.originalDueDate)}</span>
            {d.extensionRef ? ` (${d.extensionRef})` : ""}
          </span>
        ) : null}
        {d.isProvisional ? <span>· the date depends on your AGM and may change</span> : null}
        {d.filedOn ? (
          <span>
            · filed <span className="num tabular-nums">{formatDate(d.filedOn)}</span>
          </span>
        ) : null}
      </p>
      {d.acknowledgementNo ? (
        <p className="flex items-center gap-1 text-sm text-text-muted">
          Acknowledgement <span className="num font-medium text-text tabular-nums">{d.acknowledgementNo}</span>
          <CopyButton value={d.acknowledgementNo} label="acknowledgement number" />
        </p>
      ) : null}
      {need ? (
        need.kind === "nothing" ? (
          <p className="text-sm text-text-muted">{need.note}</p>
        ) : compact ? (
          <p className="text-sm text-text">
            <span className="font-medium">{need.source === "asked" ? "We've asked for: " : "What we need from you: "}</span>
            {need.items.join("; ")}.
          </p>
        ) : (
          <div className="mt-1 rounded-md bg-surface-2 px-3 py-2.5">
            <p className="text-sm font-medium text-text">{need.source === "asked" ? "What we've asked you for" : "What we need from you"}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-text">
              {need.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-sm text-text-muted">{need.note}</p>
            {need.source === "asked" ? (
              <Link href="/portal/documents" className="mt-1 inline-flex min-h-8 items-center text-sm font-medium text-primary hover:underline">
                Upload under Documents
              </Link>
            ) : null}
          </div>
        )
      ) : null}
    </li>
  )
}

export function DeadlineList({
  rows,
  today,
  openRequestItems = [],
  showNeeds = "none",
  compact = false,
  emptyMessage,
  emptyAction,
  className,
}: {
  rows: PortalDeadline[]
  today: string
  openRequestItems?: readonly string[]
  showNeeds?: NeedsMode
  compact?: boolean
  emptyMessage: string
  emptyAction?: React.ReactNode
  className?: string
}) {
  if (rows.length === 0) return <EmptyState size="compact" icon={<CalendarClockIcon />} message={emptyMessage} action={emptyAction} className={className} />
  return (
    <ul className={cn("divide-y divide-border/70", className)}>
      {rows.map((d) => (
        <DeadlineItem key={d.id} d={d} today={today} openRequestItems={openRequestItems} showNeeds={showNeeds} compact={compact} />
      ))}
    </ul>
  )
}
