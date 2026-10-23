import Link from "next/link"
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ClientWarning } from "@/components/client360/logic/warnings"

/**
 * The warnings strip under the Client 360 header (§7.3.3): one line per problem, each with where
 * to fix it. Nothing renders when there is nothing to warn about. Colour is never the only signal:
 * every line has an icon and words. Server-safe.
 */
export function WarningsStrip({ warnings }: { warnings: ClientWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <section aria-label={`${warnings.length} warning${warnings.length === 1 ? "" : "s"} about this client`} className="rounded-lg border border-warning/40 bg-surface">
      <ul className="divide-y divide-border">
        {warnings.map((w) => {
          const Icon = w.tone === "danger" ? CircleAlertIcon : TriangleAlertIcon
          return (
            <li key={w.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 md:px-5">
              <p className="flex min-w-0 items-start gap-2 text-sm text-text">
                <Icon aria-hidden="true" className={cn("mt-0.5 size-3.5 flex-none", w.tone === "danger" ? "text-danger-text" : "text-warning-text")} />
                <span>
                  <span className="sr-only">{w.tone === "danger" ? "Problem: " : "Warning: "}</span>
                  {w.message}
                </span>
              </p>
              {w.action ? (
                <Link
                  href={w.action.href}
                  className="ml-5.5 flex-none rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:ml-0"
                >
                  {w.action.label}
                </Link>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
