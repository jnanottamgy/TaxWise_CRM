import Link from "next/link"
import { cn } from "@/lib/utils"
import { QUALITY_TABS, type QualityTab } from "@/lib/schemas/quality"

/**
 * The quality module's sections (§7.15.4), one view each (`/quality?tab=`): the quality system
 * (SQC 1, peer review, acceptance, KYC, previous auditors, independence, retention, restore drills)
 * and data protection (§6.10: notices, consents, requests, incidents). A grouped list beside the
 * content on wide screens; a row that scrolls inside itself on narrow ones. A count marks a section
 * with something waiting. Server-safe.
 */
export function QualityNav({ active, counts }: { active: QualityTab; counts: Partial<Record<QualityTab, number>> }) {
  const groups = QUALITY_TABS.reduce<Array<{ group: string; items: Array<(typeof QUALITY_TABS)[number]> }>>((acc, t) => {
    const last = acc[acc.length - 1]
    if (last && last.group === t.group) last.items.push(t)
    else acc.push({ group: t.group, items: [t] })
    return acc
  }, [])
  const badge = (id: QualityTab) => {
    const n = counts[id] ?? 0
    return n > 0 ? (
      <span className="num ml-auto rounded-full bg-warning-soft px-1.5 text-xs font-medium text-warning-text" aria-label={`${n} waiting`}>
        {n}
      </span>
    ) : null
  }
  return (
    <nav aria-label="Quality sections" className="min-w-0">
      <div className="hidden lg:flex lg:flex-col lg:gap-5">
        {groups.map((g) => (
          <div key={g.group} className="flex flex-col gap-0.5">
            <p className="px-3 pb-1 text-xs font-medium text-text-muted">{g.group}</p>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((t) => {
                const current = t.id === active
                return (
                  <li key={t.id}>
                    <Link
                      href={t.id === "overview" ? "/quality" : `/quality?tab=${t.id}`}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        current ? "bg-primary-soft font-medium text-primary" : "text-text hover:bg-surface-2"
                      )}
                    >
                      {t.label}
                      {badge(t.id)}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:thin] md:-mx-6 md:px-6 lg:hidden">
        <ul className="flex w-max gap-1">
          {QUALITY_TABS.map((t) => {
            const current = t.id === active
            return (
              <li key={t.id}>
                <Link
                  href={t.id === "overview" ? "/quality" : `/quality?tab=${t.id}`}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                    current ? "bg-primary-soft font-medium text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text"
                  )}
                >
                  {t.label}
                  {badge(t.id)}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
