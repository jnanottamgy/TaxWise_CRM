import Link from "next/link"
import { cn } from "@/lib/utils"
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/domain/enums"
import { formatNumber } from "@/lib/format"
import type { VaultFolders as Folders, VaultParams } from "@/lib/data/documents"
import { documentsHref } from "@/components/documents/doc-urls"

type SearchParams = Record<string, string | string[] | undefined>

/**
 * The vault's folders (§7.14 "folders by category and FY"): All documents, each category that has
 * files, each FY, documents expiring or due for renewal, and (Partners/Managers) the recycle bin.
 * Every folder is a link with its count. A rail beside the list on wide screens; on narrow screens
 * the vault shows the same choices as two selects above the list (VaultToolbar). Server-safe.
 */
export function VaultFolders({
  clientId,
  folders,
  params,
  searchParams,
  canSeeBin,
  className,
}: {
  clientId: string
  folders: Folders
  params: VaultParams
  searchParams: SearchParams
  canSeeBin: boolean
  className?: string
}) {
  const href = (patch: Record<string, string | null>) => documentsHref(clientId, { docs: "vault", doc: null, ...patch }, searchParams)
  const allActive = !params.category && !params.fy && !params.bin && !params.expiring
  return (
    <nav aria-label="Document folders" className={cn("flex flex-col gap-4", className)}>
      <ul className="flex flex-col gap-0.5">
        <FolderLink href={href({ dcat: null, dfy: null, dbin: null, dexp: null })} active={allActive} label="All documents" count={folders.total} />
        {folders.expiringSoon > 0 ? (
          <FolderLink href={href({ dexp: "1", dbin: null, dcat: null, dfy: null })} active={params.expiring} label="Expiring or due for renewal" count={folders.expiringSoon} />
        ) : null}
      </ul>

      <div>
        <h3 className="px-2 pb-1 text-sm text-text-muted">Category</h3>
        {folders.categories.length === 0 ? (
          <p className="px-2 text-sm text-text-muted">No documents yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {folders.categories.map((c) => (
              <FolderLink
                key={c.category}
                href={href({ dcat: params.category === c.category ? null : c.category, dbin: null, dexp: null })}
                active={params.category === c.category && !params.bin}
                label={DOCUMENT_CATEGORY_LABELS[c.category]}
                count={c.count}
              />
            ))}
          </ul>
        )}
      </div>

      {folders.years.length > 0 ? (
        <div>
          <h3 className="px-2 pb-1 text-sm text-text-muted">Financial year</h3>
          <ul className="flex flex-col gap-0.5">
            {folders.years.map((y) => {
              const value = y.fy ?? "none"
              return (
                <FolderLink
                  key={value}
                  href={href({ dfy: params.fy === value ? null : value, dbin: null, dexp: null })}
                  active={params.fy === value && !params.bin}
                  label={y.fy ? `FY ${y.fy}` : "No FY"}
                  count={y.count}
                />
              )
            })}
          </ul>
        </div>
      ) : null}

      {canSeeBin ? (
        <ul className="flex flex-col gap-0.5 border-t border-border pt-3">
          <FolderLink href={href({ dbin: params.bin ? null : "1", dcat: null, dfy: null, dexp: null })} active={params.bin} label="Recycle bin" count={folders.inBin} />
        </ul>
      ) : null}
    </nav>
  )
}

function FolderLink({ href, active, label, count }: { href: string; active: boolean; label: string; count: number }) {
  return (
    <li>
      <Link
        href={href}
        scroll={false}
        prefetch={false}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex h-8 items-center justify-between gap-3 rounded-md px-2 text-base transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
          active ? "bg-primary-soft font-medium text-primary" : "text-text hover:bg-surface-2"
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        <span className={cn("num flex-none text-sm tabular-nums", active ? "text-primary" : "text-text-muted")}>{formatNumber(count)}</span>
      </Link>
    </li>
  )
}
