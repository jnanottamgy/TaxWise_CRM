import { CheckCheckIcon, CheckIcon, CircleDotDashedIcon, CircleIcon, EyeIcon, InboxIcon, TriangleAlertIcon, CircleSlashIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { getStatus } from "@/lib/status"
import { toneClasses } from "@/components/app/tones"
import { displayChip, FAMILY_META, type EventDisplay, type EventFamily } from "@/components/compliance/logic/event"

/**
 * Status marks for the filings grid and the calendar (§7.7, §3.4 "status is never colour alone"):
 * a pale tint with an icon whose shape differs per status, and the §3.6 short label where there is
 * room. The label (or the cell's aria-label) always names the status; the legend explains the icons.
 * Server-safe.
 */

const ICONS: Record<EventDisplay, typeof CheckIcon> = {
  not_started: CircleIcon,
  documents_awaited: InboxIcon,
  in_progress: CircleDotDashedIcon,
  under_review: EyeIcon,
  filed: CheckIcon,
  completed: CheckCheckIcon,
  overdue: TriangleAlertIcon,
  cancelled: CircleSlashIcon,
}

/** The status's §3.6 label, short where the vocabulary has one ("Docs awaited"). */
export function displayLabel(d: EventDisplay, short = false): string {
  const chip = displayChip(d)
  const info = getStatus(chip.kind, chip.value)
  return short && info.shortLabel ? info.shortLabel : info.label
}

export function displayTone(d: EventDisplay) {
  const chip = displayChip(d)
  return getStatus(chip.kind, chip.value).tone
}

export function StatusMark({
  display,
  showLabel = true,
  count,
  flagged = false,
  className,
}: {
  display: EventDisplay
  showLabel?: boolean
  /** "2/3" when a cell holds several deadlines: done of total. */
  count?: { done: number; total: number } | null
  /** An unfiled GST return near its three-year bar (§6.7): a red ring. */
  flagged?: boolean
  className?: string
}) {
  const t = toneClasses(displayTone(display))
  const Icon = ICONS[display]
  return (
    <span
      data-slot="status-mark"
      className={cn(
        "inline-flex h-7 w-full min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 text-xs leading-4 font-medium whitespace-nowrap",
        t.soft,
        t.border,
        t.text,
        flagged && "ring-2 ring-danger ring-offset-1 ring-offset-surface",
        className
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 flex-none" />
      {showLabel ? <span className="truncate">{displayLabel(display, true)}</span> : null}
      {count && count.total > 1 ? <span className="num flex-none tabular-nums opacity-80">{`${count.done}/${count.total}`}</span> : null}
    </span>
  )
}

/** The legend over the grid: every mark with its label. */
export function StatusLegend({ className }: { className?: string }) {
  const items: EventDisplay[] = ["not_started", "documents_awaited", "in_progress", "under_review", "filed", "completed", "overdue"]
  return (
    <ul aria-label="What the marks mean" className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-muted", className)}>
      {items.map((d) => {
        const Icon = ICONS[d]
        const t = toneClasses(displayTone(d))
        return (
          <li key={d} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("inline-flex size-5 items-center justify-center rounded border", t.soft, t.border, t.text)}>
              <Icon className="size-3" />
            </span>
            {displayLabel(d)}
          </li>
        )
      })}
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-flex size-5 rounded border border-border ring-2 ring-danger ring-offset-1 ring-offset-surface" />
        Near the three-year filing limit
      </li>
    </ul>
  )
}

export function FamilyDot({ family, className }: { family: EventFamily; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 flex-none rounded-full", FAMILY_META[family].dot, className)} />
}

export function FamilyLegend({ className }: { className?: string }) {
  return (
    <ul aria-label="Colours by type" className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted", className)}>
      {(Object.keys(FAMILY_META) as EventFamily[]).map((f) => (
        <li key={f} className="inline-flex items-center gap-1.5">
          <FamilyDot family={f} />
          {FAMILY_META[f].label}
        </li>
      ))}
    </ul>
  )
}
