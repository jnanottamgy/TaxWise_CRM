import Link from "next/link"
import { AlertTriangleIcon, ArrowRightIcon } from "lucide-react"
import { KpiStrip } from "@/components/app/kpi-strip"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { DefinitionList } from "@/components/app/definition-list"
import { formatCount } from "@/components/app/data-table/params"
import { formatDate, formatDateTime } from "@/lib/format"
import { REGISTER_FIELD_SPECS } from "@/lib/domain/gstr2b"
import { BUCKET_META, RECON_BUCKETS, periodLongLabel } from "@/lib/schemas/gst-recon"
import type { RunDetail } from "@/lib/data/gst-recon"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { Gstr2bSourceDownload } from "@/components/workpapers/recon/source-download"

const TAB_OF: Record<string, string> = { matched: "matched", mismatch: "mismatch", missing_in_books: "missing_in_books", missing_in_2b: "missing_in_2b" }

/** The ITC figures of a run (§7.8.1 "a summary card"): the answer leads, ITC at risk. Server-safe. */
export function RunFigures({ detail }: { detail: RunDetail }) {
  const itc = detail.summary.summary.itc
  const b = detail.summary.summary.buckets
  return (
    <KpiStrip
      lead
      className="mb-4"
      items={[
        {
          label: "ITC at risk",
          value: <PaiseAmount value={itc.atRisk} />,
          sub: itc.atRisk > 0 ? `${formatCount(b.missing_in_2b.count)} not in 2B, ${formatCount(b.mismatch.count)} mismatched` : "Nothing at risk",
          href: `/workpapers/gst-recon/${detail.run.id}?tab=missing_in_2b`,
        },
        {
          label: "Unclaimed ITC",
          value: <PaiseAmount value={itc.unclaimed} />,
          sub: `${formatCount(b.missing_in_books.count)} in 2B, not in books`,
          href: `/workpapers/gst-recon/${detail.run.id}?tab=missing_in_books`,
        },
        { label: "ITC per GSTR-2B", value: <PaiseAmount value={itc.per2b} />, sub: `${formatCount(detail.summary.summary.documents.portal)} documents` },
        { label: "ITC per books", value: <PaiseAmount value={itc.perBooks} />, sub: `${formatCount(detail.summary.summary.documents.books)} documents` },
      ]}
    />
  )
}

/**
 * The Summary tab of a run (§7.8.1, §6.12): the four buckets with their documents and GST on each
 * side, what carried forward, the warnings, the source files and the history of the month.
 * Server-safe.
 */
export function RunSummary({ detail, rerun }: { detail: RunDetail; rerun: React.ReactNode }) {
  const s = detail.summary
  const itc = s.summary.itc
  const runId = detail.run.id
  const mapping = detail.sources.mapping
  const issues = detail.diagnostics.gstr2b.length + detail.diagnostics.register.length
  const duplicates = s.warnings.filter((w) => w.code === "duplicate_in_books" || w.code === "duplicate_in_2b")
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <SectionCard title="By bucket" description="Documents and GST on each side. A line is matched when every tax head agrees within ₹1." flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-base">
              <caption className="sr-only">Reconciliation by bucket</caption>
              <thead className="bg-surface-2">
                <tr className="text-sm text-text-muted">
                  <th scope="col" className="h-9 px-4 text-left font-normal md:px-5">
                    Bucket
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-normal">
                    Documents
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-normal">
                    GST in 2B
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-normal">
                    GST in books
                  </th>
                  <th scope="col" className="h-9 px-4 text-right font-normal md:px-5">
                    Difference
                  </th>
                </tr>
              </thead>
              <tbody>
                {RECON_BUCKETS.map((k) => {
                  const row = s.summary.buckets[k]
                  const meta = BUCKET_META[k]
                  return (
                    <tr key={k} className="h-11 border-t border-border">
                      <th scope="row" className="px-4 text-left font-normal md:px-5">
                        <Link href={`/workpapers/gst-recon/${runId}?tab=${TAB_OF[k]}`} className="inline-flex items-center gap-1 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                          <StatusChip label={meta.label} tone={meta.tone} meaning={meta.meaning} />
                        </Link>
                      </th>
                      <td className="num px-3 text-right tabular-nums">{formatCount(row.count)}</td>
                      <td className="px-3 text-right">
                        <PaiseAmount value={row.portalItc} />
                      </td>
                      <td className="px-3 text-right">
                        <PaiseAmount value={row.booksItc} />
                      </td>
                      <td className="px-4 text-right md:px-5">
                        <PaiseAmount value={row.portalItc - row.booksItc} signed muted={row.portalItc === row.booksItc} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-sm text-text-muted md:px-5">
            {itc.reversalPending > 0 ? (
              <p>
                Credit notes in GSTR-2B not yet booked: ITC goes down by <PaiseAmount value={itc.reversalPending} /> once they are booked and accepted.
              </p>
            ) : null}
            {itc.notAvailablePer2b !== 0 ? (
              <p>
                GSTR-2B marks <PaiseAmount value={itc.notAvailablePer2b} /> of ITC as not available; it is left out of ITC per GSTR-2B.
              </p>
            ) : null}
            <p>
              Matched on the document number {formatCount(s.summary.byTier.exact)}, on the number written differently {formatCount(s.summary.byTier.loose)}, on amount and date{" "}
              {formatCount(s.summary.byTier.fuzzy)}.
            </p>
          </div>
        </SectionCard>

        {s.carryForward ? (
          <SectionCard
            title="Carried forward"
            description={`Open lines from ${periodLongLabel(s.carryForward.fromPeriod)} checked against this month's files.`}
            action={
              <Link href={`/workpapers/gst-recon/${runId}?tab=carried`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                Open <ArrowRightIcon aria-hidden="true" className="size-3.5" />
              </Link>
            }
          >
            <DefinitionList
              items={[
                { term: "Still open", value: `${formatCount(s.carryForward.stillOpen)} ${s.carryForward.stillOpen === 1 ? "line" : "lines"}`, align: "right" },
                { term: "Cleared this month", value: `${formatCount(s.carryForward.cleared)} ${s.carryForward.cleared === 1 ? "line" : "lines"}`, align: "right" },
              ]}
            />
          </SectionCard>
        ) : null}

        {duplicates.length > 0 ? (
          <SectionCard title="Duplicates" description="Documents that appear more than once: check for a double claim of ITC.">
            <ul className="flex flex-col gap-1.5 text-sm text-text">
              {duplicates.slice(0, 20).map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none text-warning-text" />
                  {w.message}
                </li>
              ))}
              {duplicates.length > 20 ? <li className="text-text-muted">{formatCount(duplicates.length - 20)} more in the Excel export.</li> : null}
            </ul>
          </SectionCard>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <SectionCard title="Source files" action={rerun}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-text-muted">GSTR-2B</p>
                <p className="truncate text-base text-text" title={detail.sources.gstr2b?.fileName}>
                  {detail.sources.gstr2b?.fileName ?? "Not stored"}
                </p>
                <p className="text-sm text-text-muted">
                  {detail.run.portal_gstin ? `For ${detail.run.portal_gstin}` : "No GSTIN in the file"}
                  {s.gstr2b.generatedOn ? ` · generated ${formatDate(s.gstr2b.generatedOn)}` : ""}
                </p>
              </div>
              {detail.sources.gstr2b ? <Gstr2bSourceDownload runId={runId} fileName={detail.sources.gstr2b.fileName} /> : null}
            </div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-text-muted">Purchase register</p>
                <p className="truncate text-base text-text" title={s.register.fileName ?? undefined}>
                  {s.register.fileName ?? detail.sources.register?.fileName ?? "Not stored"}
                </p>
                <p className="text-sm text-text-muted">
                  {formatCount(s.register.accepted)} rows read
                  {s.register.rejected ? `, ${formatCount(s.register.rejected)} left out` : ""}
                  {s.register.sheet ? ` · sheet “${s.register.sheet}”` : ""}
                </p>
              </div>
              {detail.registerDocumentId ? (
                <Link href={`/clients/${detail.client.id}?tab=documents&doc=${detail.registerDocumentId}`} className="text-sm text-primary hover:underline">
                  Open in documents
                </Link>
              ) : null}
            </div>
            {mapping ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-text">Columns used</summary>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  {REGISTER_FIELD_SPECS.map((f) => (
                    <div key={f.field} className="contents">
                      <dt className="text-text-muted">{f.label}</dt>
                      <dd className="min-w-0 truncate text-text">{mapping[f.field] ?? "Not mapped"}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </div>
        </SectionCard>

        {issues > 0 ? (
          <SectionCard title="Notes from reading the files" description="Rows left out of the register, and parts of the GSTR-2B that couldn't be read.">
            <details className="text-sm">
              <summary className="cursor-pointer text-text">
                {formatCount(issues)} {issues === 1 ? "note" : "notes"}
              </summary>
              <ul className="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto text-text-muted">
                {detail.diagnostics.register.slice(0, 100).map((d, i) => (
                  <li key={`r${i}`}>
                    <span className={d.level === "error" ? "text-danger-text" : "text-text"}>{d.row > 0 ? `Row ${d.row}` : "Register"}:</span> {d.message}
                  </li>
                ))}
                {detail.diagnostics.gstr2b.slice(0, 100).map((d, i) => (
                  <li key={`g${i}`}>
                    <span className={d.level === "error" ? "text-danger-text" : "text-text"}>GSTR-2B{d.ref ? ` ${d.ref}` : ""}:</span> {d.message}
                  </li>
                ))}
              </ul>
              {issues > 200 || detail.diagnostics.truncated.register + detail.diagnostics.truncated.gstr2b > 0 ? <p className="mt-2 text-text-muted">The full list is in the Excel export.</p> : null}
            </details>
          </SectionCard>
        ) : null}

        {detail.history.length > 1 ? (
          <SectionCard title={`Runs of ${periodLongLabel(detail.run.period)}`} flush>
            <ul>
              {detail.history.map((h) => (
                <li key={h.id} className="flex h-11 items-center justify-between gap-3 border-t border-border px-4 first:border-t-0 md:px-5">
                  {h.id === runId ? (
                    <span className="text-sm text-text">This run</span>
                  ) : (
                    <Link href={`/workpapers/gst-recon/${h.id}`} className="text-sm text-primary hover:underline">
                      {h.is_latest ? "Latest run" : "Earlier run"}
                    </Link>
                  )}
                  <span className="num text-sm text-text-muted tabular-nums">
                    {formatDateTime(h.created_at)}
                    {h.created_by_name ? ` · ${h.created_by_name}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        ) : null}
      </div>
    </div>
  )
}
