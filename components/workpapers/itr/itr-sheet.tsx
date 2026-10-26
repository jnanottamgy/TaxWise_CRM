"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import type { ItrResult, RegimeComputation } from "@/lib/domain/itr"
import { REGIMES, type Regime } from "@/lib/domain/itr-rulesets"
import { REGIME_LABEL, interestSectionLabels, regimeSummary, sideBySideRows, type SheetRow } from "@/lib/schemas/itr"
import { BalanceText, TaxFigure, taxAmount } from "@/components/workpapers/itr/itr-ui"

/**
 * The computation sheet (§6.11 "a computation sheet with every line explained, the regime
 * comparison, the saving, and the recommended regime"; §7.8.2 "a side-by-side computation (old vs
 * new) with every line"). Drawn from an ItrResult the server computed (or, in the editor, the live
 * preview of the same engine). The PDF (server/pdf/itr-computation.tsx) draws the same rows.
 */

// =================================================================================================
// The answer: which regime, and what it saves
// =================================================================================================

export function ItrComparison({ result, chosen, className }: { result: ItrResult; chosen?: Regime | null; className?: string }) {
  const rec = result.recommendedRegime
  const other: Regime = rec === "new" ? "old" : "new"
  const rows: Array<{ label: string; key: keyof ReturnType<typeof regimeSummary>; strong?: boolean }> = [
    { label: "Total income", key: "totalIncome" },
    { label: "Tax liability", key: "liability" },
    { label: "Interest", key: "interest" },
    { label: "Tax and interest", key: "taxAndInterest", strong: true },
    { label: "Taxes paid", key: "paid" },
  ]
  const summaries = { new: regimeSummary(result.regimes.new), old: regimeSummary(result.regimes.old) }
  return (
    <section aria-labelledby="itr-comparison-title" className={cn("rounded-lg border border-border bg-surface", className)}>
      <div className="border-b border-border px-4 py-4 md:px-5">
        <h2 id="itr-comparison-title" className="text-sm text-text-muted">
          Recommended regime
        </h2>
        <p className="mt-1 font-serif text-[30px] leading-9 font-[450] tracking-[-0.015em] text-text">
          {REGIME_LABEL[rec]}
          {result.saving > 0 ? (
            <span className="ml-2 text-md font-normal text-text-muted">
              saves <TaxFigure value={result.saving} className="font-semibold text-success-text" />
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-sm text-text-muted">{result.comparison.note}</p>
        {chosen ? (
          <p className={cn("mt-2 text-sm", chosen !== rec && result.saving > 0 ? "text-warning-text" : "text-text")}>
            Regime chosen by the reviewer: <span className="font-medium">{REGIME_LABEL[chosen]}</span>
            {chosen !== rec && result.saving > 0 ? ` (costs ${taxAmount(result.saving)} more than the ${REGIME_LABEL[rec].toLowerCase()})` : ""}
          </p>
        ) : null}
      </div>
      <table className="w-full text-base">
        <caption className="sr-only">Both regimes compared</caption>
        <thead>
          <tr className="text-sm text-text-muted">
            <th scope="col" className="px-4 py-2 text-left font-normal md:px-5">
              <span className="sr-only">Figure</span>
            </th>
            {[rec, other].map((r) => (
              <th key={r} scope="col" className="px-4 py-2 text-right font-normal md:px-5">
                {REGIME_LABEL[r]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border/70">
              <th scope="row" className={cn("px-4 py-2 text-left font-normal text-text md:px-5", row.strong && "font-semibold")}>
                {row.label}
              </th>
              {[rec, other].map((r) => (
                <td key={r} className={cn("px-4 py-2 text-right md:px-5", row.strong && "font-semibold")}>
                  <TaxFigure value={summaries[r][row.key]} />
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-border">
            <th scope="row" className="px-4 py-2.5 text-left font-semibold text-text md:px-5">
              Balance
            </th>
            {[rec, other].map((r) => (
              <td key={r} className="px-4 py-2.5 text-right font-semibold md:px-5">
                <BalanceText balance={summaries[r].balance} className="justify-end" />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  )
}

// =================================================================================================
// Every line, both regimes
// =================================================================================================

function Cell({ row, regime, workings }: { row: SheetRow; regime: Regime; workings: boolean }) {
  const c = row.cells[regime]
  if (!c) return <span className="text-text-muted">—</span>
  return (
    <span className="flex flex-col items-end gap-0.5">
      <TaxFigure value={c.amount} className={row.emphasis ? "font-semibold" : undefined} />
      {workings && c.detail ? <span className="max-w-[34ch] text-right text-xs leading-4 text-text-muted">{c.detail}</span> : null}
      {workings && c.note ? <span className="max-w-[34ch] text-right text-xs leading-4 text-text-muted">{c.note}</span> : null}
    </span>
  )
}

export function ItrSheet({ result, recommended, className, title = "Computation, both regimes" }: { result: ItrResult; recommended?: Regime; className?: string; title?: string }) {
  const [workings, setWorkings] = React.useState(true)
  const rows = React.useMemo(() => sideBySideRows(result), [result])
  const rec = recommended ?? result.recommendedRegime
  const switchId = React.useId()
  return (
    <section aria-labelledby="itr-sheet-title" className={cn("min-w-0 rounded-lg border border-border bg-surface", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
        <div className="min-w-0">
          <h2 id="itr-sheet-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">
            {result.yearLabel} · {result.actName}. Amounts in rupees; every figure is computed on the server from the inputs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={workings} onCheckedChange={setWorkings} />
          <Label htmlFor={switchId} className="text-sm font-normal text-text-muted">
            Show workings
          </Label>
        </div>
      </div>

      {/* Desktop and tablet: one table, the regimes side by side. */}
      <div className="hidden md:block">
        <table className="w-full text-base">
          <caption className="sr-only">
            {title}, {result.yearLabel}
          </caption>
          <thead className="sticky top-0 z-[1] bg-surface-2">
            <tr className="text-sm text-text-muted">
              <th scope="col" className="w-[44%] px-5 py-2 text-left font-normal">
                Particulars
              </th>
              {REGIMES.map((r) => (
                <th key={r} scope="col" className="px-5 py-2 text-right font-normal">
                  {REGIME_LABEL[r]}
                  {r === rec ? <span className="ml-1 text-xs text-success-text">(recommended)</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <React.Fragment key={row.code}>
                {row.group ? (
                  <tr className="border-t border-border">
                    <th colSpan={3} scope="colgroup" className="px-5 pt-3 pb-1 text-left text-sm font-medium text-text-muted">
                      {row.group}
                    </th>
                  </tr>
                ) : null}
                <tr className="border-t border-border/60 align-top">
                  <th scope="row" className={cn("px-5 py-2 text-left font-normal text-text", row.emphasis && "font-semibold")}>
                    {row.label}
                    {row.section ? <span className="mt-0.5 block text-xs font-normal text-text-muted">{row.section.label}</span> : null}
                  </th>
                  {REGIMES.map((r) => (
                    <td key={r} className="px-5 py-2 text-right">
                      <Cell row={row} regime={r} workings={workings} />
                    </td>
                  ))}
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: each line as a short card with both regimes under it. */}
      <ul className="md:hidden">
        {rows.map((row) => (
          <li key={row.code} className="border-t border-border/70 px-4 py-2.5">
            {row.group ? <p className="mb-1 text-xs font-medium text-text-muted">{row.group}</p> : null}
            <p className={cn("text-base text-text", row.emphasis && "font-semibold")}>{row.label}</p>
            {row.section ? <p className="text-xs text-text-muted">{row.section.label}</p> : null}
            <dl className="mt-1 grid grid-cols-2 gap-x-3">
              {REGIMES.map((r) => (
                <div key={r} className="min-w-0">
                  <dt className="text-xs text-text-muted">
                    {REGIME_LABEL[r]}
                    {r === rec ? " (rec.)" : ""}
                  </dt>
                  <dd className="text-right">
                    <Cell row={row} regime={r} workings={workings} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {result.notes.length ? (
        <div className="border-t border-border px-4 py-3 md:px-5">
          <h3 className="text-sm font-medium text-text">Notes</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-text-muted">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

// =================================================================================================
// Interest workings (ss.234A/234B/234C; ss.423–425 under the 2025 Act)
// =================================================================================================

function RegimeInterest({ c, labels }: { c: RegimeComputation; labels: { s234A: string; s234B: string; s234C: string } }) {
  const { s234A, s234B, s234C } = c.interest
  return (
    <div className="min-w-0">
      <h4 className="text-sm font-medium text-text">{REGIME_LABEL[c.regime]}</h4>
      <dl className="mt-2 space-y-3 text-sm">
        <div>
          <dt className="flex items-baseline justify-between gap-3">
            <span className="text-text">Late filing ({labels.s234A})</span>
            <TaxFigure value={s234A.interest} />
          </dt>
          <dd className="mt-0.5 text-xs text-text-muted">{s234A.reason}</dd>
        </div>
        <div>
          <dt className="flex items-baseline justify-between gap-3">
            <span className="text-text">Default in advance tax ({labels.s234B})</span>
            <TaxFigure value={s234B.interest} />
          </dt>
          <dd className="mt-0.5 text-xs text-text-muted">{s234B.reason}</dd>
        </div>
        <div>
          <dt className="flex items-baseline justify-between gap-3">
            <span className="text-text">Deferment of advance tax ({labels.s234C})</span>
            <TaxFigure value={s234C.interest} />
          </dt>
          <dd className="mt-0.5 text-xs text-text-muted">
            {s234C.instalments.length ? (
              <table className="mt-1 w-full text-xs">
                <caption className="sr-only">Instalments for {REGIME_LABEL[c.regime]}</caption>
                <thead>
                  <tr className="text-text-muted">
                    <th scope="col" className="py-0.5 text-left font-normal">
                      Due
                    </th>
                    <th scope="col" className="py-0.5 text-right font-normal">
                      Payable
                    </th>
                    <th scope="col" className="py-0.5 text-right font-normal">
                      Paid
                    </th>
                    <th scope="col" className="py-0.5 text-right font-normal">
                      Interest
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s234C.instalments.map((x) => (
                    <tr key={x.dueDate} className="border-t border-border/60">
                      <td className="num py-0.5">
                        {formatDate(x.dueDate)} <span className="text-text-muted">({x.cumulativePercent}%)</span>
                      </td>
                      <td className="py-0.5 text-right">
                        <TaxFigure value={x.due} />
                      </td>
                      <td className="py-0.5 text-right">
                        <TaxFigure value={x.paid} />
                      </td>
                      <td className="py-0.5 text-right">{x.safeHarbourMet ? <span className="text-text-muted">Safe harbour</span> : <TaxFigure value={x.interest} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              s234C.reason
            )}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function ItrInterestDetails({ result, className }: { result: ItrResult; className?: string }) {
  const labels = interestSectionLabels(result, "screen")
  const total = result.regimes.new.interest.total + result.regimes.old.interest.total
  return (
    <details className={cn("group rounded-lg border border-border bg-surface", className)} open={total > 0}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-md font-semibold text-text outline-none focus-visible:outline-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
        Interest workings
        <span className="text-sm font-normal text-text-muted group-open:hidden">Show</span>
        <span className="hidden text-sm font-normal text-text-muted group-open:inline">Hide</span>
      </summary>
      <div className="grid grid-cols-1 gap-6 border-t border-border px-4 py-4 md:grid-cols-2 md:px-5">
        <p className="text-sm text-text-muted md:col-span-2">
          Filing date {formatDate(result.dates.filingDate)}; due date of the return {formatDate(result.dates.dueDate)}. Each line says how its interest is worked out, at the rate and
          rounding in the year&apos;s rule set.
        </p>
        {REGIMES.map((r) => (
          <RegimeInterest key={r} c={result.regimes[r]} labels={labels} />
        ))}
      </div>
    </details>
  )
}
