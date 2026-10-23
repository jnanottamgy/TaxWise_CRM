"use client"

import * as React from "react"
import Link from "next/link"
import { ExternalLinkIcon, ShieldCheckIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { DefinitionList } from "@/components/app/definition-list"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { EMPTY, formatDate, formatDateTime } from "@/lib/format"
import { INDEPENDENCE_QUESTIONS } from "@/lib/schemas/onboarding"
import type { AcceptanceRow, FrozenHit } from "@/lib/data/acceptance"
import { NewConflictCheckButton } from "@/components/acceptance/new-check-button"

export const OUTCOME_CHIP = {
  pending: { label: "Pending", tone: "warning" as const, meaning: "Pending: checked, no decision yet. Audit work can't be onboarded until it's accepted." },
  accepted: { label: "Accepted", tone: "success" as const, meaning: "Accepted: the firm may take this prospect on. The matches are frozen with the decision." },
  declined: { label: "Declined", tone: "danger" as const, meaning: "Declined: the firm won't take this prospect on." },
}

const STRENGTH: Record<string, { label: string; tone: string }> = {
  exact: { label: "Exact match", tone: "border-danger/30 bg-danger-soft text-danger-text" },
  strong: { label: "Same name", tone: "border-warning/40 bg-warning-soft text-warning-text" },
  possible: { label: "Close name", tone: "border-border bg-surface-2 text-text-muted" },
}

const KIND_LABEL: Record<string, string> = {
  client: "Client",
  lead: "Lead",
  contact: "Client contact",
  kyc_person: "Director or partner",
  acceptance_party: "Related party in an earlier check",
  group: "Client group",
}

function hitHref(h: FrozenHit): string | null {
  if (h.client_id) return `/clients/${h.client_id}`
  if (h.lead_id) return `/leads/${h.lead_id}`
  return null
}

/**
 * The client acceptance register (§7.5.4): when each check ran, the prospect (PAN, GSTIN), how many
 * matches it found (and an independence threat for audit work), the decision with its decider and
 * date, and the lead or client it belongs to. Opening a row shows the matches as frozen at the
 * decision, the rationale and the independence answers. Sorted, filtered and paged in SQL.
 */
export function AcceptancesTable(props: { rows: AcceptanceRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; isFiltered: boolean }) {
  const { rows, total, page, pageSize, sort, dir, isFiltered } = props
  const [openId, setOpenId] = React.useState<string | null>(null)
  const current = rows.find((r) => r.id === openId) ?? null

  const columns = React.useMemo<DataTableColumn<AcceptanceRow>[]>(
    () => [
      {
        id: "created_at",
        header: "Checked",
        sortable: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            <span className="num tabular-nums">{formatDate(r.created_at)}</span>
            {r.created_by_name ? <span className="text-xs text-text-muted">{r.created_by_name}</span> : null}
          </span>
        ),
        mobileCell: (r) => formatDate(r.created_at),
      },
      {
        id: "prospect_name",
        header: "Prospect",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "28%",
        cell: (r) => (
          <button type="button" onClick={() => setOpenId(r.id)} className="flex min-w-0 cursor-pointer flex-col text-left leading-5 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <span className="truncate font-medium text-text underline-offset-4 hover:underline">{r.prospect_name}</span>
            {r.pan || r.gstin ? <span className="truncate font-mono text-xs text-text-muted">{[r.pan, r.gstin].filter(Boolean).join(" · ")}</span> : <span className="text-xs text-text-muted">No PAN or GSTIN</span>}
          </button>
        ),
        mobileCell: (r) => (
          <button type="button" onClick={() => setOpenId(r.id)} className="text-left font-medium">
            {r.prospect_name}
          </button>
        ),
      },
      {
        id: "conflict_count",
        header: "Matches",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <span className={cn("num tabular-nums", r.conflict_count > 0 ? "font-medium text-warning-text" : "text-text-muted")}>{r.conflict_count === 0 ? "None" : r.conflict_count}</span>
            {r.independence_threat ? <span className="text-xs text-danger-text">Independence threat</span> : null}
          </span>
        ),
        mobileCell: (r) => (r.conflict_count === 0 ? "No matches" : `${r.conflict_count} ${r.conflict_count === 1 ? "match" : "matches"}`),
      },
      {
        id: "outcome",
        header: "Decision",
        sortable: true,
        mobile: "trailing",
        cell: (r) => <StatusChip {...OUTCOME_CHIP[r.outcome]} />,
      },
      {
        id: "decided_at",
        header: "Decided",
        sortable: true,
        hideBelow: "lg",
        cell: (r) =>
          r.decided_at ? (
            <span className="inline-flex flex-col leading-5">
              <span className="num tabular-nums">{formatDate(r.decided_at)}</span>
              <span className="text-xs text-text-muted">{r.decided_by_name ?? EMPTY}</span>
            </span>
          ) : (
            <span className="text-text-muted">{EMPTY}</span>
          ),
      },
      {
        id: "linked",
        header: "For",
        hideBelow: "xl",
        cell: (r) =>
          r.client_id ? (
            <Link href={`/clients/${r.client_id}`} className="truncate underline-offset-4 hover:underline">
              {r.client_code} · {r.client_display_name}
            </Link>
          ) : r.lead_id ? (
            <Link href={`/leads/${r.lead_id}`} className="truncate underline-offset-4 hover:underline">
              {[r.lead_number, r.lead_name].filter(Boolean).join(" · ")}
            </Link>
          ) : (
            <span className="text-text-muted">Not linked</span>
          ),
      },
    ],
    [],
  )

  return (
    <>
      <DataTable
        id="acceptance-register"
        caption="Client acceptance register"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "created_at", dir: "desc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "check" : "checks"}`}
        isFiltered={isFiltered}
        columnChooser
        empty={
          <EmptyState
            icon={<ShieldCheckIcon />}
            message="No conflict checks yet. Run one before taking on a new client; it's required for audit work."
            action={<NewConflictCheckButton size="sm" />}
          />
        }
      />
      <Sheet open={current !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="right" className="w-[min(100%,32rem)] overflow-y-auto">
          {current ? <AcceptanceDetail row={current} /> : null}
        </SheetContent>
      </Sheet>
    </>
  )
}

function AcceptanceDetail({ row }: { row: AcceptanceRow }) {
  const answered = row.independence_answers
  return (
    <div className="flex flex-col gap-5 px-5 pt-5 pb-8">
      <SheetHeader className="p-0 pr-8">
        <SheetTitle className="text-lg">{row.prospect_name}</SheetTitle>
        <SheetDescription>
          Checked {formatDateTime(row.created_at)}
          {row.created_by_name ? ` by ${row.created_by_name}` : ""}
        </SheetDescription>
      </SheetHeader>
      <DefinitionList
        items={[
          { term: "Decision", value: <StatusChip {...OUTCOME_CHIP[row.outcome]} /> },
          { term: "Decided", value: row.decided_at ? `${formatDateTime(row.decided_at)}${row.decided_by_name ? `, ${row.decided_by_name}` : ""}` : null },
          { term: "Rationale", value: row.rationale ? <span className="whitespace-pre-line">{row.rationale}</span> : null },
          { term: "PAN", value: row.pan ? <MonoId value={row.pan} copy label="PAN" /> : null },
          { term: "GSTIN", value: row.gstin ? <MonoId value={row.gstin} copy label="GSTIN" /> : null },
          { term: "Related parties", value: row.related_parties.length ? row.related_parties.join(", ") : null },
          {
            term: "For",
            value: row.client_id ? (
              <Link href={`/clients/${row.client_id}`} className="font-medium underline-offset-4 hover:underline">
                {row.client_code} · {row.client_display_name}
              </Link>
            ) : row.lead_id ? (
              <Link href={`/leads/${row.lead_id}`} className="font-medium underline-offset-4 hover:underline">
                {[row.lead_number, row.lead_name].filter(Boolean).join(" · ")}
              </Link>
            ) : null,
          },
        ]}
      />

      <section aria-labelledby={`${row.id}-hits`}>
        <h3 id={`${row.id}-hits`} className="text-sm font-semibold text-text">
          {row.conflict_count === 0 ? "No matches" : `${row.conflict_count} ${row.conflict_count === 1 ? "match" : "matches"}`}
          {row.outcome !== "pending" ? ", as frozen with the decision" : ""}
        </h3>
        {row.conflicts.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {row.conflicts.map((h, i) => {
              const s = STRENGTH[h.strength] ?? STRENGTH.possible
              const href = hitHref(h)
              return (
                <li key={i} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-base text-text">
                      <span className="text-sm text-text-muted">{KIND_LABEL[h.kind] ?? h.kind.replace(/_/g, " ")}: </span>
                      {href ? (
                        <Link href={href} className="font-medium underline-offset-4 hover:underline">
                          {h.title}
                          <ExternalLinkIcon className="ml-1 inline size-3.5 align-[-2px] text-text-muted" aria-hidden="true" />
                        </Link>
                      ) : (
                        <span className="font-medium">{h.title}</span>
                      )}
                    </p>
                    <span className={cn("flex-none rounded-full border px-2 py-0.5 text-xs font-medium", s.tone)}>{s.label}</span>
                  </div>
                  {h.reasons.length ? <p className="mt-1 text-sm text-text-muted">{h.reasons.join(" ")}</p> : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-text-muted">Nothing matched in clients, leads, contacts, directors, partners or related parties.</p>
        )}
      </section>

      {answered ? (
        <section aria-labelledby={`${row.id}-ind`}>
          <h3 id={`${row.id}-ind`} className="text-sm font-semibold text-text">
            Independence (audit work)
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {INDEPENDENCE_QUESTIONS.map((q) => (
              <li key={q.key} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-text">{q.question}</span>
                <span className={cn("flex-none font-medium", answered[q.key] === "yes" ? "text-danger-text" : "text-text-muted")}>{answered[q.key] === "yes" ? "Yes" : answered[q.key] === "no" ? "No" : EMPTY}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
