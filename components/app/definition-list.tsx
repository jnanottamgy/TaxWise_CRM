import { cn } from "@/lib/utils"
import { EMPTY } from "@/lib/format"

export interface DefinitionItem {
  term: string
  /** null, undefined or "" render a grey em dash; a real zero prints. */
  value: React.ReactNode
  /** Right-align numbers and amounts. */
  align?: "left" | "right"
  /** Span both columns in a two-column list (addresses, notes). */
  wide?: boolean
}

/**
 * Key-value rows for detail pages and header cards (Client 360 profile, invoice facts). Terms grey
 * (13), values ink (14). One column in narrow containers; `columns={2}` splits into two when the container is at least 672px wide. Server-safe.
 *
 *   <DefinitionList
 *     items={[
 *       { term: "PAN", value: <MonoId value="AAKFS1234C" copy label="PAN" /> },
 *       { term: "GSTIN", value: <MonoId value="29AAKFS1234C1Z5" copy label="GSTIN" /> },
 *       { term: "Place of supply", value: "Karnataka (29)" },
 *       { term: "Monthly fee", value: <Money value={12500} />, align: "right" },
 *       { term: "Notes", value: null },
 *     ]}
 *     columns={2}
 *   />
 */
export function DefinitionList({
  items,
  columns = 1,
  className,
}: {
  items: DefinitionItem[]
  columns?: 1 | 2
  className?: string
}) {
  return (
    <div className="@container/dl">
    <dl
      data-slot="definition-list"
      className={cn("grid grid-cols-1 gap-x-8", columns === 2 && "@2xl/dl:grid-cols-2", className)}
    >
      {items.map((item, i) => {
        const missing = item.value === null || item.value === undefined || item.value === ""
        return (
          <div
            key={`${item.term}-${i}`}
            className={cn(
              "grid min-h-9 grid-cols-[minmax(7.5rem,40%)_1fr] items-baseline gap-3 border-b border-border/70 py-2 last:border-b-0",
              columns === 2 && "@2xl/dl:[&:nth-last-child(2):nth-child(odd)]:border-b-0",
              item.wide && columns === 2 && "@2xl/dl:col-span-2"
            )}
          >
            <dt className="text-sm leading-5 text-text-muted">{item.term}</dt>
            <dd
              className={cn(
                "min-w-0 text-base leading-5 break-words text-text",
                item.align === "right" && "num text-right tabular-nums",
                missing && "text-text-muted"
              )}
            >
              {missing ? EMPTY : item.value}
            </dd>
          </div>
        )
      })}
    </dl>
    </div>
  )
}
