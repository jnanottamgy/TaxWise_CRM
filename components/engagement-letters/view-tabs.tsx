import Link from "next/link"
import { cn } from "@/lib/utils"
import { formatCount } from "@/components/app/data-table/params"
import { LETTER_VIEWS, LETTER_VIEW_LABEL, type LetterView } from "@/lib/schemas/engagement-letters"

/** Letters · No letter for the FY · Expiring in 30 days, as underline tabs on a 1px rule, each with its count. Server-safe. */
export function LetterViewTabs({ active, fy, counts, className }: { active: LetterView; fy: string; counts: Partial<Record<LetterView, number | null>>; className?: string }) {
  return (
    <nav aria-label="Engagement letter views" className={cn("-mx-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0", className)}>
      <ul className="flex min-w-max items-center gap-0.5 border-b border-border">
        {LETTER_VIEWS.map((v) => {
          const on = v === active
          const n = counts[v]
          const href = v === "letters" ? `/engagement-letters?year=${fy}` : `/engagement-letters?view=${v}&year=${fy}`
          return (
            <li key={v}>
              <Link
                href={href}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text",
                )}
              >
                {v === "missing" ? `No letter for FY ${fy}` : LETTER_VIEW_LABEL[v]}
                {typeof n === "number" ? <span className="num text-xs text-text-muted tabular-nums">{formatCount(n)}</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
