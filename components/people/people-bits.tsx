import Link from "next/link"
import { cn } from "@/lib/utils"
import { StatusChip } from "@/components/app/status-chip"
import { CAPACITY_BAND_LABELS, type CapacityAssessment, type CapacityBand } from "@/lib/domain/capacity"
import { PRESENCE_STATUS_LABELS, type PresenceStatus } from "@/lib/domain/presence"
import { LOGIN_STATUS, type LoginStatus } from "@/lib/schemas/people"
import { CAPACITY_WINDOW_DAYS } from "@/lib/schemas/people"

/**
 * Small people marks used across People, Leave, covers and Profile. Server-safe (StatusChip is a
 * client component and renders inside them).
 */

// CLEAR is the normal state, so it stays grey: colour marks only the people who are filling up.
const BAND_TONE: Record<CapacityBand, "neutral" | "info" | "warning" | "danger"> = {
  clear: "neutral",
  busy: "info",
  tight: "warning",
  over: "danger",
}

/** The capacity band (§7.11.4) with the arithmetic on hover: "12 open tasks over 10 working days = 1.2 a day". */
export function CapacityChip({ capacity, className }: { capacity: CapacityAssessment | null | undefined; className?: string }) {
  if (!capacity) return <StatusChip kind="task_status" value={null} className={className} />
  return (
    <StatusChip
      label={CAPACITY_BAND_LABELS[capacity.band]}
      tone={BAND_TONE[capacity.band]}
      meaning={`${CAPACITY_BAND_LABELS[capacity.band]}: ${capacity.arithmetic}, over the next ${CAPACITY_WINDOW_DAYS} days (overdue tasks included; weekends, holidays and approved leave excluded).`}
      className={className}
    />
  )
}

const PRESENCE_TONE: Record<PresenceStatus, "success" | "warning" | "muted"> = { online: "success", idle: "warning", offline: "muted" }
const PRESENCE_MEANING: Record<PresenceStatus, string> = {
  online: "Online: the app is open and was in use in the last 20 minutes.",
  idle: "Idle: the app is open but hasn't been in use for 20 to 45 minutes.",
  offline: "Offline: not signed in, or the app hasn't been in use for over 45 minutes.",
}

export function PresenceChip({ status, className }: { status: PresenceStatus; className?: string }) {
  return <StatusChip label={PRESENCE_STATUS_LABELS[status]} tone={PRESENCE_TONE[status]} meaning={PRESENCE_MEANING[status]} className={className} />
}

export function LoginStatusChip({ status, onLeave = false, className }: { status: LoginStatus; onLeave?: boolean; className?: string }) {
  if (status === "active" && onLeave) {
    return <StatusChip label="On leave today" tone="violet" meaning="On leave today: approved leave covers today. Their clients may need cover." className={className} />
  }
  const s = LOGIN_STATUS[status]
  return <StatusChip label={s.label} tone={s.tone} meaning={s.meaning} className={className} />
}

/** Initials in a 32px circle (no photo is fetched in lists). */
export function PersonInitials({ name, size = "md", className }: { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const initials =
    name
      .replace(/^(ca|cs|cma|mr|mrs|ms|dr)\.?\s+/i, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full border border-border bg-surface-2 font-medium text-text-muted",
        size === "sm" ? "size-6 text-[11px]" : size === "lg" ? "size-14 text-md" : "size-8 text-xs",
        className
      )}
    >
      {initials}
    </span>
  )
}

/** A person's name linking to their page. */
export function PersonLink({ id, name, className }: { id: string | null | undefined; name: string | null | undefined; className?: string }) {
  if (!name) return <span className="text-text-muted">—</span>
  if (!id) return <span className={className}>{name}</span>
  return (
    <Link
      href={`/people/${id}`}
      className={cn("rounded-sm text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}
    >
      {name}
    </Link>
  )
}

export interface TabItem {
  id: string
  label: string
  href: string
}

/**
 * Page tabs as links (?tab=…), so each tab renders on the server with only its own data. The active
 * tab carries aria-current; on phones the row scrolls sideways inside itself.
 */
export function TabNav({ items, active, label, className }: { items: TabItem[]; active: string; label: string; className?: string }) {
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
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text"
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
