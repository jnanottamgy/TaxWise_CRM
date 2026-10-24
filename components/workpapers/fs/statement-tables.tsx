import { cn } from "@/lib/utils"
import type { StatementLine, StatementNote } from "@/lib/domain/schedule3"
import { PaiseAmount } from "@/components/workpapers/shared/amount"

/** "EQUITY AND LIABILITIES" → "Equity and liabilities": the screen sets headings in weight, not capitals. */
function screenLabel(label: string): string {
  return /[A-Z]/.test(label) && label === label.toUpperCase() ? label.charAt(0) + label.slice(1).toLowerCase() : label
}

/**
 * A statement in Schedule III (Division I) order (§6.13): Particulars, the note number, this year
 * and last year (from last year's saved statement). Headings and totals in weight, items indented;
 * negatives in brackets. Wide content scrolls inside its own frame on a phone. Server-safe.
 */
export function StatementTable({ title, lines, years, onNote }: { title: string; lines: StatementLine[]; years: { current: string; previous: string | null }; onNote?: (note: number) => void }) {
  const showPrevious = years.previous !== null
  return (
    <section aria-label={title} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-base">
          <caption className="px-4 pt-4 pb-3 text-left text-md font-semibold text-text md:px-5">{title}</caption>
          <thead className="bg-surface-2">
            <tr className="text-sm text-text-muted">
              <th scope="col" className="h-9 px-4 text-left font-normal md:px-5">
                Particulars
              </th>
              <th scope="col" className="h-9 w-16 px-2 text-center font-normal">
                Note
              </th>
              <th scope="col" className="h-9 w-40 px-3 text-right font-normal">
                FY {years.current}
              </th>
              {showPrevious ? (
                <th scope="col" className="h-9 w-40 px-4 text-right font-normal md:px-5">
                  FY {years.previous}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const heading = l.kind === "heading" || l.kind === "group"
              const total = l.kind === "total"
              const pad = l.kind === "group" ? "pl-7 md:pl-8" : l.kind === "item" ? "pl-10 md:pl-11" : l.kind === "subitem" ? "pl-14 md:pl-15" : "pl-4 md:pl-5"
              return (
                <tr key={l.key} className={cn("border-t border-border", total && "border-t-text/40 bg-surface-2/40")}>
                  <th scope="row" className={cn("h-10 pr-3 text-left", pad, heading || total ? "font-semibold text-text" : "font-normal text-text")}>
                    {l.ref ? <span className="mr-2 text-text-muted">{l.ref}</span> : null}
                    {screenLabel(l.label)}
                  </th>
                  <td className="px-2 text-center text-sm text-text-muted">
                    {l.note ? (
                      onNote ? (
                        <button type="button" onClick={() => onNote(l.note as number)} className="rounded-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Note ${l.note}`}>
                          {l.note}
                        </button>
                      ) : (
                        l.note
                      )
                    ) : null}
                  </td>
                  <td className={cn("px-3 text-right", total && "font-semibold")}>{heading ? null : <PaiseAmount value={l.current ?? 0} brackets />}</td>
                  {showPrevious ? <td className={cn("px-4 text-right text-text-muted md:px-5", total && "font-semibold")}>{heading ? null : <PaiseAmount value={l.previous} brackets muted />}</td> : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** One note to the statements: its ledger break-up, an ageing schedule, the MSME disclosure, or text. */
export function NoteView({ note, years, extra, children }: { note: StatementNote; years: { current: string; previous: string | null }; extra?: string | null; children?: React.ReactNode }) {
  const showPrevious = years.previous !== null && note.kind === "ledgers"
  return (
    <section id={`note-${note.number}`} aria-labelledby={`note-${note.number}-title`} className="min-w-0 scroll-mt-20 rounded-lg border border-border bg-surface">
      <h3 id={`note-${note.number}-title`} className="px-4 pt-4 pb-3 text-md font-semibold text-text md:px-5">
        <span className="mr-2 text-text-muted">{note.number}</span>
        {note.title}
      </h3>
      {note.kind === "text" ? null : note.table ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-surface-2">
              <tr className="text-text-muted">
                <th scope="col" className="h-9 px-4 text-left font-normal md:px-5">
                  Particulars
                </th>
                {note.table.columns.map((c) => (
                  <th key={c} scope="col" className="h-9 px-3 text-right font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {note.table.rows.map((r, i) => {
                const last = i === (note.table?.rows.length ?? 0) - 1
                return (
                  <tr key={`${r.label}-${i}`} className="border-t border-border">
                    <th scope="row" className={cn("h-10 px-4 text-left md:px-5", last ? "font-semibold" : "font-normal")}>
                      {r.label}
                    </th>
                    {r.values.map((v, j) => (
                      <td key={j} className={cn("px-3 text-right", last && "font-semibold")}>
                        <PaiseAmount value={v} />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-base">
            <thead className="bg-surface-2">
              <tr className="text-sm text-text-muted">
                <th scope="col" className="h-9 px-4 text-left font-normal md:px-5">
                  {note.kind === "msme" ? "Disclosure" : "Ledger"}
                </th>
                <th scope="col" className="h-9 w-40 px-3 text-right font-normal">
                  FY {years.current}
                </th>
                {showPrevious ? (
                  <th scope="col" className="h-9 w-40 px-4 text-right font-normal md:px-5">
                    FY {years.previous}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {note.lines.length === 0 ? (
                <tr className="border-t border-border">
                  <td colSpan={showPrevious ? 3 : 2} className="h-10 px-4 text-text-muted md:px-5">
                    Nil
                  </td>
                </tr>
              ) : (
                note.lines.map((l, i) => (
                  <tr key={`${l.label}-${i}`} className="border-t border-border">
                    <th scope="row" className="h-10 px-4 text-left font-normal md:px-5">
                      {l.label}
                    </th>
                    <td className="px-3 text-right">
                      <PaiseAmount value={l.current} brackets />
                    </td>
                    {showPrevious ? (
                      <td className="px-4 text-right md:px-5">
                        <PaiseAmount value={l.previous} brackets muted />
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
              {note.total ? (
                <tr className="border-t border-text/40 bg-surface-2/40">
                  <th scope="row" className="h-10 px-4 text-left font-semibold md:px-5">
                    Total
                  </th>
                  <td className="px-3 text-right font-semibold">
                    <PaiseAmount value={note.total.current} brackets />
                  </td>
                  {showPrevious ? (
                    <td className="px-4 text-right font-semibold md:px-5">
                      <PaiseAmount value={note.total.previous} brackets muted />
                    </td>
                  ) : null}
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      {extra ? <p className="border-t border-border px-4 py-3 text-base whitespace-pre-wrap text-text md:px-5">{extra}</p> : null}
      {children ? <div className="border-t border-border px-4 py-3 md:px-5">{children}</div> : null}
    </section>
  )
}
