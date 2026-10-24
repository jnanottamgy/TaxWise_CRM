"use client"

import * as React from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const InsideInteractive = React.createContext(false)

/**
 * Marks content that sits inside a link or button (a KPI tile that opens its list): a FullValueHint
 * in it isn't a tab stop of its own, which would nest one focusable inside another (invalid HTML
 * and a second, silent stop for keyboard users). The hint still shows on hover, and screen readers
 * still read the full value.
 */
export function WithinInteractive({ children }: { children: React.ReactNode }) {
  return <InsideInteractive.Provider value={true}>{children}</InsideInteractive.Provider>
}

/**
 * A shortened figure that shows its full value on hover and keyboard focus (e.g. `₹12.3L` →
 * `₹12,34,567.00`, §3.4). Screen readers get the full value directly.
 *
 *   <FullValueHint short="₹12.3L" full="₹12,34,567.00" />
 */
export function FullValueHint({ short, full, className }: { short: string; full: string; className?: string }) {
  const inside = React.useContext(InsideInteractive)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={inside ? undefined : 0}
          title={full}
          className={cn(
            "cursor-help rounded-sm underline decoration-text-muted/40 decoration-dotted underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            className
          )}
        >
          <span aria-hidden="true">{short}</span>
          <span className="sr-only">{full}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="num">{full}</TooltipContent>
    </Tooltip>
  )
}
