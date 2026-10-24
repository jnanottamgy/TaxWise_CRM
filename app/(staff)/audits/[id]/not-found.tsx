import Link from "next/link"
import { SearchXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * An audit engagement that doesn't exist, was deleted at Acceptance, or isn't visible to this role
 * (Partners and Managers only, §4.1; RLS answers "not found" rather than say it exists).
 */
export default function AuditNotFound() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <SearchXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Audit engagement not found</h1>
            <p className="mt-1 text-base text-text-muted">It may have been deleted while still at Acceptance, or the link is wrong. Find it in the audit list.</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button asChild>
            <Link href="/audits">Go to audit engagements</Link>
          </Button>
        </div>
      </section>
    </div>
  )
}
