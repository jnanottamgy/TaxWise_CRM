import Link from "next/link"
import { XIcon } from "lucide-react"

/**
 * "Client  TW-C-0042 · Sharma Traders ✕": a workpaper register narrowed to one client (from Client
 * 360), with the link that shows every client again. Server-safe.
 */
export function ClientScopeChip({ name, clearHref }: { name: string; clearHref: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-text-muted">Client</span>
      <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-text">
        <span className="truncate">{name}</span>
        <Link
          href={clearHref}
          aria-label="Show every client"
          className="-mr-1 inline-flex size-5 flex-none items-center justify-center rounded-full text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </span>
    </div>
  )
}
