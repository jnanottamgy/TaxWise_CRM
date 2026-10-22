import Link from "next/link"
import { cn } from "@/lib/utils"

export const LAW_TABS = [
  { id: "parameters", label: "Statutory parameters" },
  { id: "rules", label: "Due-date rules" },
  { id: "extensions", label: "Extensions" },
  { id: "concordance", label: "Section concordance" },
  { id: "log", label: "Change log" },
] as const
export type LawTab = (typeof LAW_TABS)[number]["id"]

export function isLawTab(v: unknown): v is LawTab {
  return typeof v === "string" && LAW_TABS.some((t) => t.id === v)
}

/**
 * The Law & rules tabs, as links (`?tab=`), so each is its own server-rendered, shareable view.
 * A count of items awaiting confirmation sits beside a tab's name. Server-safe.
 */
export function LawTabs({ active, awaiting }: { active: LawTab; awaiting: Partial<Record<LawTab, number>> }) {
  return (
    <nav aria-label="Law and rules" className="-mx-4 overflow-x-auto px-4 md:-mx-0 md:px-0">
      <ul className="flex w-max min-w-full gap-1 border-b border-border">
        {LAW_TABS.map((t) => {
          const current = t.id === active
          const n = awaiting[t.id] ?? 0
          return (
            <li key={t.id}>
              <Link
                href={`/settings/law?tab=${t.id}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-10 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  current ? "border-primary font-medium text-text" : "border-transparent text-text-muted hover:text-text"
                )}
              >
                {t.label}
                {n > 0 ? (
                  <span className="num rounded-full bg-warning-soft px-1.5 text-xs font-medium text-warning-text" aria-label={`${n} awaiting confirmation`}>
                    {n}
                  </span>
                ) : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
