import Link from "next/link"
import { SearchXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/app/page-header"

/** A quotation that doesn't exist, or is in the recycle bin. */
export default function QuotationNotFound() {
  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader breadcrumbs={[{ label: "Quotations", href: "/quotations" }, { label: "Not found" }]} title="Quotation not found" />
      <section className="flex max-w-2xl gap-3 rounded-lg border border-border bg-surface px-5 py-4">
        <SearchXIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
        <div className="min-w-0">
          <p className="text-base text-text">This quotation doesn&apos;t exist, or it has been moved to the recycle bin.</p>
          <div className="mt-3">
            <Button asChild variant="outline">
              <Link href="/quotations">Back to quotations</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
