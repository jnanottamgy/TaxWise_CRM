import { cn } from "@/lib/utils"
import { PageBreadcrumbs } from "@/components/app/page-breadcrumbs"

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
  leading,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  breadcrumbs?: Crumb[]
  /** A picture beside the title block (a person's initials), kept outside the h1 so it isn't part of the title text. */
  leading?: React.ReactNode
  /** Small facts beside the title (a status chip, a code). */
  meta?: React.ReactNode
  /** One primary (filled) action at most; the rest outline or ghost. */
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header data-slot="page-header" className={cn("flex flex-col gap-2 pb-4 md:pb-6", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? <PageBreadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {leading}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="min-w-0 text-xl leading-8 font-semibold tracking-[-0.01em] text-balance text-text">{title}</h1>
              {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
            </div>
            {description ? <p className="mt-1 max-w-[72ch] text-base text-text-muted">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
      </div>
    </header>
  )
}

/** The breadcrumb trail (a client component, so PageHeader can hide it where the top bar shows it). */
export { Breadcrumbs } from "@/components/app/page-breadcrumbs"
