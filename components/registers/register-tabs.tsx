import Link from "next/link"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { REGISTER_TABS, REGISTER_TAB_LABEL, registersHref, type RegisterTab } from "@/lib/schemas/registers"

/**
 * The register tabs (§7.15.1, §7.15.2): underline tabs on a full-width 1px rule, each a link
 * (`?tab=`), so a tab is shareable and the server loads only the open one. A client scope carries
 * across tabs; other filters belong to their tab and are dropped. Server-safe.
 */
export function RegisterTabs({ active, clientId, className }: { active: RegisterTab; clientId?: string | null; className?: string }) {
  return (
    <nav aria-label="Registers" className={cn("-mx-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0", className)}>
      <ul className="flex min-w-max items-center gap-0.5 border-b border-border">
        {REGISTER_TABS.map((t) => {
          const on = t === active
          return (
            <li key={t}>
              <Link
                href={registersHref(t, { client: clientId ?? null })}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text"
                )}
              >
                {REGISTER_TAB_LABEL[t]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** "Client  Sharma Traders ✕": the register is narrowed to one client (from Client 360 or a notice). Server-safe. */
export function ClientScopeChip({ name, clearHref }: { name: string; clearHref: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-text-muted">Client</span>
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-text">
        {name}
        <Link
          href={clearHref}
          aria-label="Show every client"
          className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </span>
    </div>
  )
}
