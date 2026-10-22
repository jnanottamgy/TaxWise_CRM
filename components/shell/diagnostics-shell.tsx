import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { PoweredBy, TwMonogram } from "./brand";

/**
 * The frame Settings → Diagnostics renders in when the full staff shell can't be built because the
 * database itself is what's broken (§7.24, §0.1 rule 1): the profiles read failed, so the shell has
 * no role, name or navigation to show. A Partner (by the verified token) still gets the checks.
 * Loads nothing, so it can't fail.
 */
export function DiagnosticsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex h-14 flex-none items-center justify-between gap-3 bg-brand-navy px-4 text-white md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <TwMonogram className="size-8" />
          <span className="truncate text-base font-semibold tracking-[-0.01em]">TaxWise Consultants</span>
        </div>
        <Link
          href="/login"
          className="rounded-md px-2 py-1 text-sm text-white/80 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white pointer-coarse:py-2.5"
        >
          Sign in again
        </Link>
      </header>
      <div role="status" className="border-b border-border bg-warning-soft px-4 py-2.5 text-sm text-warning-text md:px-6">
        <p className="mx-auto flex max-w-[1200px] items-start gap-2">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
          <span>
            TaxWise couldn&apos;t read your profile from the database, so only Diagnostics is open. Run the checks below
            to see what&apos;s wrong.
          </span>
        </p>
      </div>
      <main className="mx-auto w-full max-w-[1200px] min-w-0 flex-1 px-4 py-6 md:px-6">{children}</main>
      <footer className="flex justify-center px-4 py-6">
        <PoweredBy />
      </footer>
    </div>
  );
}
