"use client"

import * as React from "react"
import { SearchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select"
import { StatusChip } from "@/components/app/status-chip"
import { formatCount } from "@/components/app/data-table/params"
import { BUCKET_GROUP_LABELS, CONFIDENCE_LABELS, SCHEDULE3_BUCKETS, bucketDef, type BucketCode, type BucketGroup, type Confidence } from "@/lib/domain/buckets"
import type { StatusTone } from "@/lib/status"
import { LEDGER_SOURCE_LABELS, needsAttention, type StoredLedger } from "@/lib/schemas/financial-statements"
import { PaiseAmount } from "@/components/workpapers/shared/amount"

const GROUPS: BucketGroup[] = ["shareholders_funds", "non_current_liabilities", "current_liabilities", "non_current_assets", "current_assets", "income", "expenses"]

const CONFIDENCE_TONE: Record<Confidence, StatusTone> = { high: "success", medium: "info", low: "warning", none: "danger" }

type Filter = "attention" | "unmapped" | "all"
const PAGE = 200

/** The ledger as the editor shows it: the stored classification, or "Chosen here" once a person changed it. */
export function effectiveLedger(l: StoredLedger, bucket: BucketCode | null): StoredLedger {
  if (bucket === l.bucket) return l
  return bucket
    ? { ...l, bucket, matched: true, source: "manual", confidence: "high", reason: `Chosen here: ${bucketDef(bucket).label}.` }
    : { ...l, bucket: null, matched: false, source: "unmapped", confidence: "none", reason: "Left unmapped. Choose a line." }
}

function BucketSelect({ id, value, onChange, disabled, label }: { id: string; value: BucketCode | null; onChange: (v: BucketCode | null) => void; disabled?: boolean; label: string }) {
  return (
    <div className="[&>div]:w-full">
      <NativeSelect id={id} size="sm" value={value ?? ""} disabled={disabled} aria-label={label} aria-invalid={value === null ? true : undefined} onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as BucketCode))}>
        <NativeSelectOption value="">Not mapped</NativeSelectOption>
        {GROUPS.map((g) => (
          <NativeSelectOptGroup key={g} label={BUCKET_GROUP_LABELS[g]}>
            {SCHEDULE3_BUCKETS.filter((b) => b.group === g).map((b) => (
              <NativeSelectOption key={b.code} value={b.code}>
                {b.label}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        ))}
      </NativeSelect>
    </div>
  )
}

function ConfidenceChip({ l }: { l: StoredLedger }) {
  return <StatusChip label={l.source === "manual" ? "Chosen here" : CONFIDENCE_LABELS[l.confidence]} tone={l.source === "manual" ? "neutral" : CONFIDENCE_TONE[l.confidence]} meaning={`${LEDGER_SOURCE_LABELS[l.source]}. ${l.reason}`} />
}

/**
 * Ledger mapping (§7.8.3 step 4, §6.13 "Auto-classification"): every trial-balance ledger with its
 * Schedule III line and how sure the app is (remembered for the client, a keyword, the TB group,
 * or not mapped), the reason on hover. Opens on the ledgers that need a person; choices are
 * remembered for the client when saved. Read-only once the statement is final.
 */
export function LedgerMapping({
  ledgers,
  buckets,
  onChange,
  readOnly,
  source,
}: {
  ledgers: StoredLedger[]
  buckets: Array<BucketCode | null>
  onChange: (index: number, bucket: BucketCode | null) => void
  readOnly: boolean
  /** Where the ledgers came from (the trial balance file) and "Load a revised trial balance". */
  source?: React.ReactNode
}) {
  const effective = React.useMemo(() => ledgers.map((l, i) => effectiveLedger(l, buckets[i] ?? null)), [ledgers, buckets])
  const attention = effective.filter((l) => needsAttention(l)).length
  const unmapped = effective.filter((l) => l.bucket === null).length
  const [filter, setFilter] = React.useState<Filter>(attention > 0 ? "attention" : "all")
  const [q, setQ] = React.useState("")
  const [limit, setLimit] = React.useState(PAGE)
  const baseId = React.useId()

  const text = q.trim().toLowerCase()
  const rows = effective
    .map((l, index) => ({ l, index }))
    .filter(({ l, index }) => {
      // A ledger a person just fixed stays in the "needs attention" view until the filter changes.
      if (filter === "unmapped" && l.bucket !== null && ledgers[index].bucket !== null) return false
      if (filter === "attention" && !needsAttention(ledgers[index]) && !needsAttention(l)) return false
      if (!text) return true
      return l.name.toLowerCase().includes(text) || (l.group ?? "").toLowerCase().includes(text) || (l.bucket ? bucketDef(l.bucket).label.toLowerCase().includes(text) : false)
    })
  const shown = rows.slice(0, limit)

  return (
    <section aria-labelledby={`${baseId}-title`} className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3 md:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={`${baseId}-title`} className="text-md font-semibold text-text">
            Ledger mapping
          </h2>
          <p className="text-sm text-text-muted">
            {formatCount(ledgers.length)} ledgers · {unmapped ? <span className="text-danger-text">{formatCount(unmapped)} not mapped</span> : "every ledger mapped"}
            {attention - unmapped > 0 ? ` · ${formatCount(attention - unmapped)} to check` : ""}
          </p>
        </div>
        {source}
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-1">
            {(
              [
                ["attention", `Needs a look (${formatCount(attention)})`],
                ["unmapped", `Not mapped (${formatCount(unmapped)})`],
                ["all", `All (${formatCount(ledgers.length)})`],
              ] as Array<[Filter, string]>
            ).map(([f, label]) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => {
                  setFilter(f)
                  setLimit(PAGE)
                }}
                className={cn(
                  "h-8 rounded-full border px-3 text-sm transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  filter === f ? "border-text/40 bg-surface-2 font-medium text-text" : "border-border text-text-muted hover:text-text",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative md:w-72">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ledger, group or line" aria-label="Search ledgers" className="pl-8" />
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-6 text-base text-text-muted md:px-5">{ledgers.length === 0 ? "No ledgers yet. Load the trial balance to map them." : filter === "all" || text ? "No ledger matches the search." : "Nothing here: every ledger is mapped with confidence."}</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-base">
              <caption className="sr-only">Trial balance ledgers and their Schedule III lines</caption>
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr className="text-sm text-text-muted">
                  <th scope="col" className="h-9 px-5 text-left font-normal">
                    Ledger
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-normal">
                    Debit
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-normal">
                    Credit
                  </th>
                  <th scope="col" className="h-9 w-[19rem] px-3 text-left font-normal">
                    Schedule III line
                  </th>
                  <th scope="col" className="h-9 px-5 text-left font-normal">
                    Confidence
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ l, index }) => (
                  <tr key={index} className="border-t border-border">
                    <th scope="row" className="max-w-[18rem] px-5 py-2 text-left font-normal">
                      <span className="block truncate text-text" title={l.name}>
                        {l.name}
                      </span>
                      <span className="block truncate text-xs text-text-muted">{l.group ?? "No group"}</span>
                    </th>
                    <td className="px-3 text-right">{l.debit ? <PaiseAmount value={l.debit} /> : <span className="text-text-muted">–</span>}</td>
                    <td className="px-3 text-right">{l.credit ? <PaiseAmount value={l.credit} /> : <span className="text-text-muted">–</span>}</td>
                    <td className="px-3 py-1.5">
                      <BucketSelect id={`${baseId}-${index}`} value={buckets[index] ?? null} onChange={(v) => onChange(index, v)} disabled={readOnly} label={`Schedule III line for ${l.name}`} />
                    </td>
                    <td className="px-5">
                      <ConfidenceChip l={l} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden">
            {shown.map(({ l, index }) => (
              <li key={index} className="flex flex-col gap-2 border-t border-border px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base text-text">{l.name}</p>
                    <p className="truncate text-sm text-text-muted">{l.group ?? "No group"}</p>
                  </div>
                  <span className="flex flex-none flex-col items-end text-sm">
                    <PaiseAmount value={l.debit >= l.credit ? l.debit - l.credit : l.credit - l.debit} />
                    <span className="text-text-muted">{l.debit >= l.credit ? "Dr" : "Cr"}</span>
                  </span>
                </div>
                <BucketSelect id={`${baseId}-m-${index}`} value={buckets[index] ?? null} onChange={(v) => onChange(index, v)} disabled={readOnly} label={`Schedule III line for ${l.name}`} />
                <ConfidenceChip l={l} />
              </li>
            ))}
          </ul>
          {rows.length > shown.length ? (
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 md:px-5">
              <span className="text-sm text-text-muted">
                Showing {formatCount(shown.length)} of {formatCount(rows.length)}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
