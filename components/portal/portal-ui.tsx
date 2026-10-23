import Link from "next/link"
import { cn } from "@/lib/utils"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { StatusChip } from "@/components/app/status-chip"
import type { PortalStatus } from "@/lib/domain/portal-copy"

/**
 * Small pieces the portal pages share (§7.22). Server-safe; StatusChip and ErrorBlock are client
 * islands inside them.
 */

/** A block that failed to load: its own card, one sentence, the Ref and Retry (§0.1 rule 3, §3.4). */
export function PortalBlockError({ title, message, errorRef, className }: { title: string; message: string; errorRef: string; className?: string }) {
  return (
    <SectionCard title={title} className={className}>
      <ErrorBlock message={message} errorRef={errorRef} size="compact" className="px-0" />
    </SectionCard>
  )
}

/** A portal status (lib/domain/portal-copy.ts): the §3.6 dot + label, explained for the client on hover or tap. */
export function PortalStatusChip({ status, className, variant }: { status: PortalStatus; className?: string; variant?: "dot" | "pill" }) {
  return <StatusChip label={status.label} tone={status.tone} meaning={status.meaning} className={cn("flex-none", className)} variant={variant} />
}

/** A link styled as a row title. */
export function RowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("min-w-0 rounded-sm text-base font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}
    >
      {children}
    </Link>
  )
}

/** "View all 18" when there are more than are shown. */
export function moreLink(href: string, total: number, shown: number, label = "View all"): { href: string; label: string } | undefined {
  return total > shown ? { href, label: `${label} ${total.toLocaleString("en-IN")}` } : undefined
}

/** The client's file can't be found: what the portal shows instead of an empty page. */
export function NotLinked() {
  return (
    <section className="rounded-lg border border-border bg-surface px-5 py-6">
      <h2 className="text-md font-semibold text-text">Your portal isn&apos;t set up yet</h2>
      <p className="mt-1 text-base text-text-muted">
        Your login isn&apos;t linked to a client file. Ask your accountant to check your portal access; once it&apos;s linked, your deadlines, documents and invoices show here.
      </p>
    </section>
  )
}

/** Where the client's run of an async load landed (pages use it with Promise.all). */
export type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }
