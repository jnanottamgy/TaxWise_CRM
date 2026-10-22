import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import { formatStateWithCode } from "@/lib/domain/india-validators"

export interface InvoiceHeaderPreviewProps {
  logoUrl: string | null
  firmName: string
  legalName?: string | null
  tagline?: string | null
  address?: string | null
  city?: string | null
  stateCode?: string | null
  pincode?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  gstin?: string | null
  pan?: string | null
  /** The first number of this FY's invoice series, e.g. `TW/26-27/0001`. */
  sampleNumber: string
  /** Today (IST), the date the sample is dated. */
  today: string
  className?: string
}

/**
 * The letterhead as it prints at the top of a tax invoice (§6.4 Rule 46: supplier's name, address
 * and GSTIN; number and date), drawn from the values in the form so the Partner sees the effect of
 * every field and of the logo before saving. The sample number is the series' first number this FY.
 * Server-safe; the logo may be a blob: URL while a file is being checked.
 */
export function InvoiceHeaderPreview(p: InvoiceHeaderPreviewProps) {
  const line2 = [p.city, p.stateCode ? formatStateWithCode(p.stateCode) : null, p.pincode].filter(Boolean).join(" · ")
  const contact = [p.phone, p.email, p.website?.replace(/^https?:\/\//, "").replace(/\/$/, "")].filter(Boolean).join(" · ")
  return (
    <figure className={cn("min-w-0 overflow-hidden rounded-md border border-border bg-surface", p.className)}>
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between md:p-5">
        <div className="flex min-w-0 items-start gap-3">
          {p.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public branding URL or a local blob: preview
            <img src={p.logoUrl} alt={`${p.firmName} logo`} className="h-12 w-auto max-w-[9rem] flex-none object-contain" />
          ) : null}
          <div className="min-w-0">
            <p className="text-md leading-6 font-semibold break-words text-text">{p.firmName || "Firm name"}</p>
            {p.legalName && p.legalName !== p.firmName ? <p className="text-xs text-text-muted">{p.legalName}</p> : null}
            {p.tagline ? <p className="text-xs text-text-muted">{p.tagline}</p> : null}
            {p.address ? <p className="mt-1.5 text-xs whitespace-pre-line text-text">{p.address}</p> : null}
            {line2 ? <p className="text-xs text-text">{line2}</p> : null}
            {contact ? <p className="text-xs break-words text-text-muted">{contact}</p> : null}
            <p className="mt-1 text-xs text-text">
              GSTIN <span className="font-mono">{p.gstin || "not set"}</span>
              {p.pan ? (
                <>
                  {" "}
                  · PAN <span className="font-mono">{p.pan}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="flex-none text-left sm:text-right">
          <p className="text-sm font-semibold tracking-[-0.01em] text-text">Tax invoice</p>
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs sm:justify-end">
            <dt className="text-text-muted">Invoice no.</dt>
            <dd className="num font-mono text-text">{p.sampleNumber}</dd>
            <dt className="text-text-muted">Date</dt>
            <dd className="num text-text">{formatDate(p.today)}</dd>
          </dl>
        </div>
      </div>
      <figcaption className="border-t border-border bg-surface-2 px-4 py-2 text-xs text-text-muted md:px-5">
        How the top of an invoice prints with these details. Quotations, receipts and credit notes use the same letterhead.
      </figcaption>
    </figure>
  )
}
