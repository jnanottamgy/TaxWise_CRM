import Link from "next/link";
import { SearchXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PoweredBy, TwMonogram } from "@/components/shell/brand";

export const metadata = { title: "Page not found" };

/** Not found outside the app shells (an address that matches no page at all). */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <main className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex h-14 items-center gap-2.5 bg-brand-navy px-5 text-white">
          <TwMonogram className="size-8" />
          <span className="text-base font-semibold tracking-[-0.01em]">TaxWise Consultants</span>
        </div>
        <div className="px-5 py-6 sm:px-6">
          <div className="flex items-start gap-3">
            <SearchXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-text">Page not found</h1>
              <p className="mt-1 text-base text-text-muted">
                There&apos;s no page at this address. It may have been moved, or the link may be incomplete.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end">
            <Button asChild>
              <Link href="/">Go to my home page</Link>
            </Button>
          </div>
        </div>
      </main>
      <PoweredBy className="mt-6" />
    </div>
  );
}
