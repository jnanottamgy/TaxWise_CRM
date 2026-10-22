import Link from "next/link"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface Crumb {
  label: string
  href?: string
}

/**
 * The header row of every page (§3.3, DESIGN.md §4): breadcrumbs above on detail pages, the title
 * (h1, 24/600), a one-line description about the data, and the primary action at right. On phones
 * the actions wrap under the title. Server-safe.
 *
 *   <PageHeader
 *     title="Clients"
 *     description="1,284 clients · 37 waiting to finish onboarding"
 *     actions={<Button asChild><Link href="/clients/new"><PlusIcon />New client</Link></Button>}
 *   />
 *   <PageHeader
 *     breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Sharma Traders" }]}
 *     title="Sharma Traders"
 *     meta={<StatusChip kind="client_status" value="active" />}
 *   />
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  meta,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  breadcrumbs?: Crumb[]
  /** Small facts beside the title (a status chip, a code). */
  meta?: React.ReactNode
  /** One primary (filled) action at most; the rest outline or ghost. */
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header data-slot="page-header" className={cn("flex flex-col gap-2 pb-4 md:pb-6", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="min-w-0 text-xl leading-8 font-semibold tracking-[-0.01em] text-balance text-text">{title}</h1>
            {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
          </div>
          {description ? <p className="mt-1 max-w-[72ch] text-base text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
      </div>
    </header>
  )
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-text-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {c.href && !last ? (
                <Link
                  href={c.href}
                  className="truncate rounded-sm hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn("truncate", last && "text-text")}>
                  {c.label}
                </span>
              )}
              {!last ? <ChevronRightIcon aria-hidden="true" className="size-3.5 flex-none" /> : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
