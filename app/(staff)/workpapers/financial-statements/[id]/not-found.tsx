import Link from "next/link"
import { SearchXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * A statement that doesn't exist, or of a client the viewer doesn't look after (Employees see their
 * own clients only, §4.1; RLS answers "not found" rather than say it exists).
 */
export default function FinancialStatementNotFound() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <SearchXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Statement not found</h1>
            <p className="mt-1 text-base text-text-muted">The link may be wrong, or the client isn&apos;t one of yours. Find it in the list of financial statements.</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button asChild>
            <Link href="/workpapers/financial-statements">Go to financial statements</Link>
          </Button>
        </div>
      </section>
    </div>
  )
}
