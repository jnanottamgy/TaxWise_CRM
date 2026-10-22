"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { getStatus, type StatusKind, type StatusTone } from "@/lib/status"
import { EMPTY } from "@/lib/format"
import { Explain } from "@/components/app/explain"
import { toneClasses } from "@/components/app/tones"

type FromVocabulary = {
  /** A §3.6 vocabulary from lib/status.ts, e.g. "task_status", "invoice_status". */
  kind: StatusKind
  value: string | null | undefined
  label?: never
  tone?: never
  meaning?: never
}

type Explicit = {
  label: string
  tone: StatusTone
  /** What it means and what happens next. Omit for a chip with nothing to explain. */
  meaning?: string
  kind?: never
  value?: never
}

export type StatusChipProps = (FromVocabulary | Explicit) & {
  /** `dot` (default): dot + coloured label. `pill`: pale tint pair, for headers and dense grids. */
  variant?: "dot" | "pill"
  /** Use the vocabulary's short label (filings grid cells). */
  short?: boolean
  className?: string
}

/**
 * Status, never by colour alone (§3.4): a dot plus the label, explained on hover, focus or tap.
 *
 *   <StatusChip kind="task_status" value={task.status} />
 *   <StatusChip kind="invoice_status" value={invoiceDisplayStatus(inv.status, inv.is_overdue)} variant="pill" />
 *   <StatusChip label="Handed off" tone="info" meaning="Opened in WhatsApp. The app can't confirm delivery." />
 *
 * A null value renders a grey em dash. Clicks don't bubble, so it is safe inside clickable rows.
 */
export function StatusChip(props: StatusChipProps) {
  const { variant = "dot", short, className } = props
  const descId = React.useId()

  const info =
    props.kind !== undefined
      ? props.value
        ? getStatus(props.kind, props.value)
        : null
      : { label: props.label, tone: props.tone, meaning: props.meaning, shortLabel: undefined }

  if (!info) {
    return (
      <span className={cn("text-text-muted", className)} aria-label="Not set">
        {EMPTY}
      </span>
    )
  }

  const t = toneClasses(info.tone)
  const label = short && info.shortLabel ? info.shortLabel : info.label
  const body = (
    <>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", t.dot)} />
      <span className="truncate">{label}</span>
    </>
  )

  const chipClass = cn(
    "relative inline-flex max-w-full flex-none items-center gap-1.5 whitespace-nowrap rounded-full text-sm leading-5 font-medium",
    variant === "pill" ? cn("h-6 border px-2", t.soft, t.border) : "h-6 px-0.5",
    t.text,
    className
  )

  if (!info.meaning) {
    return (
      <span className={chipClass} data-slot="status-chip">
        {body}
      </span>
    )
  }

  return (
    <Explain
      content={
        <p>
          <span className="font-medium">{info.label}.</span>{" "}
          <span className="text-text-muted">{stripLead(info.meaning, info.label)}</span>
        </p>
      }
    >
      <button
        type="button"
        data-slot="status-chip"
        aria-describedby={descId}
        className={cn(
          chipClass,
          "cursor-help outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:content-['']"
        )}
      >
        {body}
        <span id={descId} hidden>
          {info.meaning}
        </span>
      </button>
    </Explain>
  )
}

/** "Data awaited: blocked on the client." → "Blocked on the client." (the label is already shown in bold). */
function stripLead(meaning: string, label: string): string {
  const prefix = `${label}:`
  if (meaning.toLowerCase().startsWith(prefix.toLowerCase())) {
    const rest = meaning.slice(prefix.length).trim()
    return rest ? rest[0].toUpperCase() + rest.slice(1) : meaning
  }
  return meaning
}
