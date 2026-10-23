import Link from "next/link"
import { SearchXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * An invoice that doesn't exist, was deleted as a draft, or isn't visible to this role (Employees
 * never see invoices, §4.1; RLS answers "not found" rather than say it exists).
 */
export default function InvoiceNotFound() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <SearchXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Invoice not found</h1>
            <p className="mt-1 text-base text-text-muted">It may be a draft that was deleted, or the link is wrong. Find it in the invoice list.</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button asChild>
            <Link href="/invoices">Go to invoices</Link>
          </Button>
        </div>
      </section>
    </div>
  )
}
