import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Download TaxWise Desktop (§7.21): the link to the latest signed installer, from Settings →
 * WhatsApp → Installer link, or NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL (§17). Server-safe.
 */
export function DesktopDownloadCard({ url, canEdit }: { url: string | null; canEdit: boolean }) {
  return (
    <section id="download" aria-labelledby="download-title" className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 md:px-5">
        <div className="min-w-0">
          <h2 id="download-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            TaxWise Desktop installer
          </h2>
          <p className="mt-0.5 max-w-[68ch] text-sm text-text-muted">
            The CRM with WhatsApp Web beside it, for office PCs. Link firm numbers only there, on office PCs; a Partner links their own number only on their own PC
            (house rule 4).
          </p>
        </div>
        {url ? (
          <Button asChild variant="outline">
            <a href={url} rel="noopener noreferrer">
              <DownloadIcon aria-hidden="true" />
              Download TaxWise Desktop
            </a>
          </Button>
        ) : (
          <p className="text-sm text-text-muted">
            {canEdit ? "No installer link yet. Add it as the Installer link under TaxWise Desktop above." : "No installer link yet. Ask a Partner for TaxWise Desktop."}
          </p>
        )}
      </div>
    </section>
  )
}
