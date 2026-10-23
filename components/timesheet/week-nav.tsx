import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { addDays, type DateString } from "@/lib/domain/fy"
import { weekLabel } from "@/lib/schemas/timesheet"

/**
 * Previous week · the week · next week, and "This week" when looking at another one. Weeks run
 * Monday to Sunday (IST); there is no going past the current week, since time can't be logged
 * ahead. Server-safe.
 */
export function WeekNav({ monday, thisMonday, hrefFor, className }: { monday: DateString; thisMonday: DateString; hrefFor: (monday: DateString) => string; className?: string }) {
  const atCurrent = monday >= thisMonday
  return (
    <nav aria-label="Week" className={cn("flex flex-wrap items-center gap-1", className)}>
      <Button asChild variant="outline" size="icon-sm" aria-label={`Previous week, ${weekLabel(addDays(monday, -7))}`}>
        <Link href={hrefFor(addDays(monday, -7))} scroll={false}>
          <ChevronLeftIcon aria-hidden="true" />
        </Link>
      </Button>
      <h2 className="num min-w-40 px-2 text-center text-sm font-semibold whitespace-nowrap text-text tabular-nums sm:min-w-44 sm:text-base" aria-live="polite">
        {weekLabel(monday)}
      </h2>
      {atCurrent ? (
        <Button variant="outline" size="icon-sm" disabled aria-label="Next week (not yet)">
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      ) : (
        <Button asChild variant="outline" size="icon-sm" aria-label={`Next week, ${weekLabel(addDays(monday, 7))}`}>
          <Link href={hrefFor(addDays(monday, 7))} scroll={false}>
            <ChevronRightIcon aria-hidden="true" />
          </Link>
        </Button>
      )}
      {!atCurrent ? (
        <Button asChild variant="ghost" size="sm" className="ml-1">
          <Link href={hrefFor(thisMonday)} scroll={false}>
            This week
          </Link>
        </Button>
      ) : null}
    </nav>
  )
}
