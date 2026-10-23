import Link from "next/link"
import { cn } from "@/lib/utils"
import type { AppRole } from "@/lib/auth/roles"
import { tabHref, visibleTabs, type ClientTabId } from "@/components/client360/logic/tabs"

/**
 * The Client 360 tab row (§7.3.3): underline tabs on a full-width 1px rule (taste §4.4), one per
 * tab this role may see, in spec order. On phones the row scrolls sideways inside itself, never
 * the page (taste §12). Each tab is a link (`?tab=`), so tabs are shareable and the server loads
 * only the open one. Server-safe.
 */
export function ClientTabNav({ clientId, role, active, className }: { clientId: string; role: AppRole; active: ClientTabId; className?: string }) {
  const tabs = visibleTabs(role)
  return (
    <nav aria-label="Client sections" className={cn("-mx-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0", className)}>
      <ul className="flex min-w-max items-center gap-0.5 border-b border-border">
        {tabs.map((t) => {
          const on = t.id === active
          return (
            <li key={t.id}>
              <Link
                href={tabHref(clientId, t.id)}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text"
                )}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
