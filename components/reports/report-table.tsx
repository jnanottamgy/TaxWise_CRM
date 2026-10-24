import Link from "next/link"
import { cn } from "@/lib/utils"
import { EMPTY } from "@/lib/format"
import { StatusChip } from "@/components/app/status-chip"
import { isLinkCell, isNumericKind, isStatusCell, reportCellText, type ReportCell, type ReportColumn, type ReportRow } from "@/components/reports/report-types"

function hideClass(h: ReportColumn["hideBelow"]) {
  return h === "lg" ? "hidden lg:table-cell" : h === "xl" ? "hidden xl:table-cell" : ""
}

function Cell({ col, value, strong }: { col: ReportColumn; value: ReportCell | undefined; strong?: boolean }) {
  if (value === null || value === undefined || value === "") return <span className="text-text-muted">{EMPTY}</span>
  if (isStatusCell(value)) return <StatusChip label={value.label} tone={value.tone} meaning={value.meaning} />
  if (isLinkCell(value)) {
    return (
      <span className="inline-flex min-w-0 flex-col leading-5">
        <Link href={value.href} className="truncate rounded-sm text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {value.text}
        </Link>
        {value.sub ? <span className="truncate text-xs text-text-muted">{value.sub}</span> : null}
      </span>
    )
  }
  const text = reportCellText(col.kind, value)
  if (typeof value === "number" && value < 0 && col.kind === "money") return <span className="text-text-muted">{text}</span>
  return <span className={cn(strong && "font-semibold")}>{text}</span>
}

/**
 * A report section's table (§7.16, DESIGN.md §3): 12px grey sentence-case headers on the one sticky
 * band, 1px row rules, no zebra, numbers right-aligned in tabular figures, the identity column
 * widest, a bold totals row under a heavier rule. Below 768px each row becomes a two-line card: the
 * identity and the key figure, then the other figures named. Server-safe.
 */
export function ReportTable({ columns, rows, totals, caption }: { columns: ReportColumn[]; rows: ReportRow[]; totals?: ReportRow | null; caption: string }) {
  const primary = columns.find((c) => c.mobile === "primary") ?? columns[0]
  const trailing = columns.filter((c) => c.mobile === "trailing")
  const secondary = columns.filter((c) => c.mobile === "secondary")
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-separate border-spacing-0 text-base">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    "h-9 bg-surface-2 px-3 text-xs leading-4 font-medium whitespace-nowrap text-text-muted shadow-[inset_0_-1px_0_var(--border)]",
                    isNumericKind(c.kind) ? "text-right" : "text-left",
                    hideClass(c.hideBelow),
                    i === 0 && "pl-4 md:pl-5",
                    i === columns.length - 1 && "pr-4 md:pr-5"
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="h-(--row-height)">
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      "border-b border-border/70 px-3 align-middle",
                      isNumericKind(c.kind) ? "num text-right whitespace-nowrap tabular-nums" : "text-left",
                      hideClass(c.hideBelow),
                      i === 0 && "max-w-[22rem] truncate pl-4 md:pl-5",
                      i === columns.length - 1 && "pr-4 md:pr-5"
                    )}
                  >
                    <Cell col={c} value={r[c.key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className="h-(--row-height)">
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      "border-t border-text-muted/40 px-3 font-semibold",
                      isNumericKind(c.kind) ? "num text-right whitespace-nowrap tabular-nums" : "text-left",
                      hideClass(c.hideBelow),
                      i === 0 && "pl-4 md:pl-5",
                      i === columns.length - 1 && "pr-4 md:pr-5"
                    )}
                  >
                    {totals[c.key] === null || totals[c.key] === undefined ? null : <Cell col={c} value={totals[c.key]} strong />}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <ul className="md:hidden" aria-label={caption}>
        {[...rows, ...(totals ? [totals] : [])].map((r, ri) => {
          const isTotal = !!totals && ri === rows.length
          const second = secondary.filter((c) => r[c.key] !== null && r[c.key] !== undefined && r[c.key] !== "")
          return (
            <li key={ri} className={cn("flex flex-col gap-0.5 border-b border-border/70 px-4 py-3 last:border-b-0", isTotal && "border-t border-t-text-muted/40 font-semibold")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 text-base leading-6 text-text">
                  <Cell col={primary} value={r[primary.key]} strong={isTotal} />
                </div>
                {trailing.length ? (
                  <div className="num flex flex-none items-center gap-2 text-right tabular-nums">
                    {trailing.map((c) => (
                      <Cell key={c.key} col={c} value={r[c.key]} strong={isTotal} />
                    ))}
                  </div>
                ) : null}
              </div>
              {second.length ? (
                <div className="flex flex-wrap items-center gap-x-1.5 text-sm leading-5 font-normal text-text-muted">
                  {second.map((c, i) => (
                    <span key={c.key} className="inline-flex items-center gap-1 whitespace-nowrap">
                      <span>{c.header}</span>
                      <span className="num text-text tabular-nums">{isStatusCell(r[c.key]) || isLinkCell(r[c.key]) ? <Cell col={c} value={r[c.key]} /> : reportCellText(c.kind, r[c.key])}</span>
                      {i < second.length - 1 ? <span aria-hidden="true">·</span> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </>
  )
}
