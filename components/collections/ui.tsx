import Link from "next/link"
import { cn } from "@/lib/utils"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { StatusChip } from "@/components/app/status-chip"
import { TDS_CREDIT_STATUS_INFO, TDS_MATCH_STATUS_INFO, formatPercent, type TdsCreditStatus, type TdsMatchStatus } from "@/lib/domain/collections"
import { reminderSlotLabel } from "@/lib/domain/collections"
import { MESSAGE_CHANNEL_LABEL } from "@/lib/handoff"

/**
 * Small pieces shared by the collections screens (§7.9.5–§7.9.10). Server-safe.
 */

/** A section that failed to load: its frame, its title, the sentence and the Ref (DESIGN.md §3). */
export function BlockError({ title, message, errorRef, className }: { title: string; message: string; errorRef?: string | null; className?: string }) {
  return (
    <SectionCard title={title} className={className} flush>
      <ErrorBlock message={message} errorRef={errorRef ?? null} />
    </SectionCard>
  )
}

export function TdsStatusChip({ status }: { status: TdsCreditStatus }) {
  const info = TDS_CREDIT_STATUS_INFO[status] ?? TDS_CREDIT_STATUS_INFO.expected
  return <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
}

export function TdsMatchChip({ status }: { status: TdsMatchStatus }) {
  const info = TDS_MATCH_STATUS_INFO[status] ?? TDS_MATCH_STATUS_INFO.unmatched
  return <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
}

const PROMISE_INFO = {
  open: { label: "Promised", tone: "info" as const, meaning: "Promised: the client said they would pay by this date. A reminder comes on the next follow-up date." },
  kept: { label: "Kept", tone: "success" as const, meaning: "Kept: the invoice was settled after the promise." },
  missed: { label: "Missed", tone: "danger" as const, meaning: "Missed: the promised date has passed with money still outstanding. Follow up and log the new date." },
}

export function PromiseChip({ status }: { status: "open" | "kept" | "missed" }) {
  const info = PROMISE_INFO[status]
  return <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
}

const REMINDER_INFO: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "muted"; meaning: string }> = {
  sent: { label: "Emailed", tone: "info", meaning: "Emailed: an older reminder that went by email." },
  handoff_pending: { label: "To send", tone: "warning", meaning: "To send: it's due, and waits for someone to send it on WhatsApp. The message and the PDF are ready." },
  handed_off: { label: "Handed off", tone: "info", meaning: "Handed off: WhatsApp opened with the reminder filled in. The app can't see whether it was sent." },
  dismissed: { label: "Not sent", tone: "muted", meaning: "Not sent: someone decided it wasn't needed, and said why." },
  failed: { label: "Failed", tone: "danger", meaning: "Failed: it didn't reach the client." },
  skipped: { label: "Skipped", tone: "muted", meaning: "Skipped: not needed when its day came." },
  pending: { label: "Planned", tone: "muted", meaning: "Planned: it goes on its day." },
}

export function ReminderChip({ status }: { status: string }) {
  const info = REMINDER_INFO[status] ?? { label: status.replace(/_/g, " "), tone: "muted" as const, meaning: "" }
  return <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
}

/** "Reminder 7 days after the due date · WhatsApp". */
export function reminderLine(key: string | null, channel: string): string {
  return `${reminderSlotLabel(key)} · ${MESSAGE_CHANNEL_LABEL[channel] ?? channel}`
}

/** A percentage in a table cell: right-aligned figures, an em dash when there's no base. */
export function Percent({ value, className }: { value: number | null; className?: string }) {
  if (value === null) {
    return (
      <span className={cn("num text-text-muted", className)} aria-label="No base to measure against">
        —
      </span>
    )
  }
  return <span className={cn("num tabular-nums", className)}>{formatPercent(value)}</span>
}

/** An ink text link inside a list row (the one action a row needs, DESIGN.md §3). */
export function RowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn("rounded-sm font-medium text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring", className)}>
      {children}
    </Link>
  )
}

/** Views of one screen as links (?tab=…), so each view has its own URL and Back works. */
export function ViewTabs({ items, active, label, className }: { items: Array<{ id: string; label: string; href: string }>; active: string; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0", className)}>
      <ul className="flex min-w-max items-center gap-1 border-b border-border">
        {items.map((t) => {
          const on = t.id === active
          return (
            <li key={t.id}>
              <Link
                href={t.href}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text",
                )}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
