import Link from "next/link"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A section on an overview (DESIGN.md §4): 1px border on surface, no shadow, 12px radius. Header row
 * with the 16/600 title and an optional right slot (period, action), the body, and an optional
 * "View all" footer. Overviews show 4–6 rows and never paginate. Server-safe.
 *
 *   <SectionCard
 *     title="Due this week"
 *     description="GSTR-3B, TDS and advance tax"
 *     action={<span className="text-sm text-text-muted">20–26 Oct</span>}
 *     viewAll={{ href: "/filings?due=week", label: "View all 18" }}
 *     flush
 *   >
 *     <ul>…</ul>
 *   </SectionCard>
 */
export function SectionCard({
  title,
  description,
  action,
  viewAll,
  footer,
  flush = false,
  headingLevel = 2,
  id,
  className,
  bodyClassName,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  /** Right side of the header: a period label, a select, one small action. */
  action?: React.ReactNode
  viewAll?: { href: string; label?: string }
  /** Custom footer (replaces viewAll). */
  footer?: React.ReactNode
  /** No body padding: for lists and tables that run to the card's edges. */
  flush?: boolean
  headingLevel?: 2 | 3
  id?: string
  className?: string
  bodyClassName?: string
  children?: React.ReactNode
}) {
  const H = headingLevel === 3 ? "h3" : "h2"
  const headingId = id ? `${id}-title` : undefined
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-slot="section-card"
      className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-surface", className)}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
        <div className="min-w-0">
          <H id={headingId} className="text-md leading-6 font-semibold text-text">
            {title}
          </H>
          {description ? <p className="mt-0.5 text-sm text-text-muted">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
      </div>
      <div className={cn("min-w-0 flex-1", flush ? "" : "px-4 pb-4 md:px-5", bodyClassName)}>{children}</div>
      {footer ? (
        <div className="border-t border-border px-4 py-2.5 md:px-5">{footer}</div>
      ) : viewAll ? (
        <div className="border-t border-border">
          <Link
            href={viewAll.href}
            className="flex min-h-10 items-center justify-between gap-2 rounded-b-lg px-4 text-sm font-medium text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 pointer-coarse:min-h-11"
          >
            {viewAll.label ?? "View all"}
            <ChevronRightIcon aria-hidden="true" className="size-4 text-text-muted" />
          </Link>
        </div>
      ) : null}
    </section>
  )
}
