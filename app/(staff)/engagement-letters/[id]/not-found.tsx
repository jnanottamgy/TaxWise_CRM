import Link from "next/link"
import { SearchXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * A letter that doesn't exist, a deleted draft, or one this role can't see (engagement letters are
 * Partner/Manager only, §4.1; RLS answers "not found" rather than say it exists).
 */
export default function LetterNotFound() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <SearchXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Letter not found</h1>
            <p className="mt-1 text-base text-text-muted">It may be a draft that was deleted, its client may be in the recycle bin, or the link is wrong.</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button asChild>
            <Link href="/engagement-letters">Go to engagement letters</Link>
          </Button>
        </div>
      </section>
    </div>
  )
}
