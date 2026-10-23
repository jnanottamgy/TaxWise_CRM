import Link from "next/link"
import { cn } from "@/lib/utils"
import { linkedLabel } from "@/lib/domain/whatsapp"
import type { LinksPerNumber } from "@/lib/data/whatsapp"

/**
 * PCs linked per firm number against WhatsApp's device limit (§7.25.1 "Staff office: 3 of 4",
 * §7.25.7). One quiet strip; a number at its limit says so in words, one over it in the danger text.
 * Server-safe.
 */
export function LinksStrip({ rows, className }: { rows: LinksPerNumber[]; className?: string }) {
  return (
    <section aria-labelledby="links-strip-title" className={cn("rounded-lg border border-border bg-surface px-4 py-3 md:px-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="links-strip-title" className="text-sm font-medium text-text">
          PCs linked per number
        </h2>
        <Link href="/settings/whatsapp#linked-pcs" className="text-sm font-medium text-primary hover:underline">
          Linked PCs
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted">No firm WhatsApp number is switched on yet. A Partner adds them in Settings → WhatsApp.</p>
      ) : (
        <ul className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1.5">
          {rows.map((r) => (
            <li key={r.number_id} className="text-sm">
              <span className="num text-text">{linkedLabel(r.label, r.active_links, r.device_limit)}</span>
              {r.over_limit ? (
                <span className="ml-1.5 text-danger-text">over WhatsApp&apos;s limit</span>
              ) : r.at_limit ? (
                <span className="ml-1.5 text-warning-text">at the limit</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
