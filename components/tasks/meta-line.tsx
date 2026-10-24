import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * A wrapping line of facts separated by "·" ("T-000033 · Hebbal Mobiles · 11 Sep 2026 · 44 days
 * overdue"). Each separator sits in a 12px gutter before its fact, and the row is pulled 12px left
 * inside a clipping frame, so the gutter at the start of every line is cut off: a wrapped line never
 * starts with a stray "·", and the first fact needs none. A fact longer than the line truncates.
 * Server-safe.
 *
 *   <MetaLine>
 *     <span className="font-mono text-xs">{task.task_number}</span>
 *     {task.client_name}
 *     <DateText date={task.due_date} withRelative today={today} />
 *   </MetaLine>
 */
export function MetaLine({ children, className }: { children: React.ReactNode; className?: string }) {
  const items = React.Children.toArray(children)
  if (items.length === 0) return null
  return (
    <div className={cn("min-w-0 overflow-hidden text-sm text-text-muted", className)}>
      <p className="-ml-3 flex flex-wrap items-center">
        {items.map((item, i) => (
          <span key={i} className="relative max-w-full min-w-0 truncate pl-3 before:absolute before:left-1 before:content-['·']">
            {item}
          </span>
        ))}
      </p>
    </div>
  )
}
