import { cn } from "@/lib/utils"

/**
 * One section of the Profile page (§7.1; DESIGN §5: sections in cards, labels above fields). 1px
 * border on surface, no shadow at rest; the heading is an h2 so the page outline reads as a list of
 * sections. Server-safe.
 */
export function ProfileCard({
  id,
  title,
  description,
  action,
  className,
  children,
}: {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  /** Right side of the header: a status chip or one small action. */
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const headingId = `${id}-title`
  return (
    <section id={id} aria-labelledby={headingId} className={cn("min-w-0 scroll-mt-20 rounded-lg border border-border bg-surface", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
        <div className="min-w-0">
          <h2 id={headingId} className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            {title}
          </h2>
          {description ? <p className="mt-0.5 max-w-[72ch] text-sm text-text-muted">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
      </div>
      <div className="min-w-0 px-4 py-4 md:px-5 md:py-5">{children}</div>
    </section>
  )
}
