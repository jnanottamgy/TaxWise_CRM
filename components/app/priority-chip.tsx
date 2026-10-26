"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { getStatus } from "@/lib/status"
import { EMPTY } from "@/lib/format"
import { Explain } from "@/components/app/explain"
import { toneClasses } from "@/components/app/tones"

const LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4, critical: 4 }

/**
 * Task or client priority (§3.6): a four-step bar glyph plus the label, so it never reads as a
 * second status dot in the same row. High and above colour the bars (warning / danger) with an ink
 * label; Low and Medium stay grey. Explains itself on hover, focus or tap.
 *
 *   <PriorityChip kind="task_priority" value={task.priority} />
 *   <PriorityChip kind="client_priority" value="critical" hideLabel />
 */
export function PriorityChip({
  kind,
  value,
  hideLabel = false,
  className,
}: {
  kind: "task_priority" | "client_priority"
  value: string | null | undefined
  /** Glyph only (the label stays available to screen readers and in the explanation). */
  hideLabel?: boolean
  className?: string
}) {
  const descId = React.useId()
  if (!value) {
    return (
      <span className={cn("text-text-muted", className)} aria-label="Not set">
        {EMPTY}
      </span>
    )
  }
  const info = getStatus(kind, value)
  const level = LEVEL[value] ?? 0
  const loud = level >= 3
  const t = toneClasses(info.tone)

  return (
    <Explain content={<p className="text-text-muted">{info.meaning}</p>}>
      <button
        type="button"
        data-slot="priority-chip"
        aria-describedby={descId}
        aria-label={hideLabel ? `${info.label} priority` : undefined}
        className={cn(
          "relative inline-flex h-6 flex-none cursor-help items-center gap-1.5 rounded-md px-0.5 text-sm whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:content-['']",
          // The bars carry the colour; the label stays ink, so red is kept for what is overdue.
          loud ? "text-text" : "text-text-muted",
          className
        )}
      >
        <span aria-hidden="true" className="flex h-3 items-end gap-[2px]">
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={cn(
                "w-[3px] rounded-[1px]",
                i <= level ? (loud ? t.dot : "bg-text-muted") : "bg-border",
                i === 1 ? "h-1" : i === 2 ? "h-1.5" : i === 3 ? "h-2.5" : "h-3"
              )}
            />
          ))}
        </span>
        {hideLabel ? null : <span>{info.label}</span>}
        <span id={descId} hidden>
          {info.meaning}
        </span>
      </button>
    </Explain>
  )
}
