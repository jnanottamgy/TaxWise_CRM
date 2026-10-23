import { TwMonogram } from "@/components/shell/brand"

/**
 * The public quotation page's frame (§7.23): a navy band with the TW mark and the firm's name, the
 * content on the page background, and the footer with "Powered by J-TACS". Server-safe, no data.
 */
export function PublicQuotationFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="bg-brand-navy text-white">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3 md:px-6">
          <span aria-hidden="true" className="inline-flex size-9 flex-none items-center justify-center rounded-[10px] bg-brand-navy ring-1 ring-white/15">
            <TwMonogram className="size-full" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-base leading-5 font-semibold">TaxWise Consultants</p>
            <p className="truncate text-sm leading-5 text-white/70">Chartered Accountants</p>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-1 flex-col px-4 py-5 md:px-6 md:py-8">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-1 px-4 py-4 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between md:px-6">
          <p>This page is for the person the quotation was sent to. Please don&apos;t share the link.</p>
          <p>
            Powered by <span className="font-semibold tracking-[0.02em] text-gold-text">J-TACS</span>
          </p>
        </div>
      </footer>
    </div>
  )
}
