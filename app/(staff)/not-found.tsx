import Link from "next/link";
import { SearchXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Not found inside the firm's app: a record or page that doesn't exist, or one this role may not see
 * (guards answer 404 rather than reveal it exists, lib/auth/guards.ts). The shell stays on screen.
 */
export default function StaffNotFound() {
  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <SearchXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">Page not found</h1>
            <p className="mt-1 text-base text-text-muted">
              It may have been moved or deleted, or it isn&apos;t available for your role. Check the link, or find the
              record with search.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button asChild variant="outline">
            <Link href="/search">Search</Link>
          </Button>
          <Button asChild>
            <Link href="/">Go to my home page</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
