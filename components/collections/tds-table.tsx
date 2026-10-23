"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BadgeIndianRupeeIcon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { MonoId } from "@/components/app/mono-id"
import { EmptyState } from "@/components/app/empty-state"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DatePicker } from "@/components/app/form/date-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { formatDate } from "@/lib/format"
import { formatINR, toPaise } from "@/lib/domain/money"
import { TDS_CREDIT_STATUS_INFO, type TdsCreditStatus } from "@/lib/domain/collections"
import type { TdsCreditRow } from "@/lib/data/tds-credits"
import type { FormError } from "@/hooks/use-action-form"
import { setDeductorTan, setTdsCreditStatus } from "@/server/actions/tds-credits"
import { TdsStatusChip } from "@/components/collections/ui"

/**
 * The TDS credit register (§7.9.9): every receipt with TDS, its client, invoice, quarter, section,
 * the TAN it was deducted under, the amount and where it stands (Expected → Reflected in 26AS / AIS
 * (Form 168) → Claimed). Select credits to mark them by hand; add a missing TAN so the statement
 * import can match it. Server-paged and sorted.
 */

/** A move of the selected credits to `status`; only those now in one of `from` move. */
type Move = { status: TdsCreditStatus; from: TdsCreditStatus[]; rows: TdsCreditRow[] }

export function TdsTable(props: { rows: TdsCreditRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string; fy: string }) {
  const { rows, total, page, pageSize, sort, dir, today, fy } = props
  const [move, setMove] = React.useState<Move | null>(null)
  const [tanFor, setTanFor] = React.useState<TdsCreditRow | null>(null)

  const columns = React.useMemo<DataTableColumn<TdsCreditRow>[]>(
    () => [
      {
        id: "client_name",
        header: "Client",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "24%",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      },
      {
        id: "invoice_number",
        header: "Invoice",
        sortable: true,
        rowLink: true,
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex flex-col leading-5">
            {r.invoice_number ? <MonoId value={r.invoice_number} /> : <span className="text-text-muted">—</span>}
            <span className="text-xs text-text-muted">Receipt {r.receipt_number}</span>
          </span>
        ),
        mobileCell: (r) => r.invoice_number ?? r.receipt_number,
      },
      { id: "payment_date", header: "Paid on", sortable: true, align: "right", cell: (r) => <DateText date={r.payment_date} today={today} /> },
      { id: "quarter", header: "Quarter", sortable: true, mobile: "secondary", cell: (r) => <span className="whitespace-nowrap">{r.quarter}</span> },
      { id: "section", header: "Section", hideBelow: "lg", cell: (r) => (r.tds_section ? <span className="whitespace-nowrap">{r.tds_section === "393" ? "s.393" : r.tds_section}</span> : <span className="text-text-muted">—</span>) },
      {
        id: "tan",
        header: "Deductor TAN",
        hideBelow: "xl",
        cell: (r) =>
          r.deductor_tan ? (
            <MonoId value={r.deductor_tan} />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 text-warning-text"
              onClick={(e) => {
                e.stopPropagation()
                setTanFor(r)
              }}
            >
              Add TAN
            </Button>
          ),
      },
      { id: "tds_amount", header: "TDS", sortable: true, align: "right", mobile: "trailing", cell: (r) => <Money value={r.tds_amount} /> },
      {
        id: "status",
        header: "Status",
        mobile: "trailing",
        cell: (r) => (
          <span className="inline-flex flex-col items-start leading-5">
            <TdsStatusChip status={r.tds_status} />
            {r.tds_status === "reflected" && r.tds_reflected_on ? <span className="text-xs text-text-muted">since {formatDate(r.tds_reflected_on)}</span> : null}
            {r.tds_status === "claimed" && r.tds_claimed_in ? <span className="text-xs text-text-muted">{r.tds_claimed_in}</span> : null}
          </span>
        ),
      },
    ],
    [today],
  )

  return (
    <>
      <DataTable
        id="tds-credits"
        caption="TDS credits"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowHref={(r) => `/invoices/${r.invoice_id}`}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "payment_date", dir: "desc" }}
        selectable
        columnChooser
        countLabel={(n, t) => `${n} ${t === 1 ? "credit" : "credits"}`}
        bulkActions={({ selectedRows, clear }) => {
          const open = (status: TdsCreditStatus, from: TdsCreditStatus[]) => {
            setMove({ status, from, rows: selectedRows })
            clear()
          }
          const any = (s: TdsCreditStatus) => selectedRows.some((r) => r.tds_status === s)
          return (
            <>
              <Button size="sm" variant="outline" disabled={!any("expected")} onClick={() => open("reflected", ["expected"])}>
                Mark reflected
              </Button>
              <Button size="sm" variant="outline" disabled={!any("reflected")} onClick={() => open("claimed", ["reflected"])}>
                Mark claimed
              </Button>
              <Button size="sm" variant="ghost" disabled={!any("reflected") && !any("claimed")} onClick={() => (any("claimed") ? open("reflected", ["claimed"]) : open("expected", ["reflected"]))}>
                Undo a step
              </Button>
            </>
          )
        }}
        empty={<EmptyState icon={<BadgeIndianRupeeIcon />} message={`No receipt in FY ${fy} has TDS on it. Record TDS on a receipt and it shows here until it is claimed.`} />}
      />
      {move ? <StatusDialog move={move} fy={fy} today={today} onClose={() => setMove(null)} /> : null}
      {tanFor ? <TanDialog row={tanFor} onClose={() => setTanFor(null)} /> : null}
    </>
  )
}

function StatusDialog({ move, fy, today, onClose }: { move: Move; fy: string; today: string; onClose: () => void }) {
  const router = useRouter()
  const rows = move.rows.filter((r) => move.from.includes(r.tds_status))
  const undo = move.from.includes("claimed") || move.status === "expected"
  const [on, setOn] = React.useState(today)
  const [note, setNote] = React.useState("")
  const [claimedIn, setClaimedIn] = React.useState(`ITR for FY ${fy}`)
  const [error, setError] = React.useState<FormError | null>(null)
  const [pending, setPending] = React.useState(false)
  const ids = { on: React.useId(), note: React.useId(), claimed: React.useId() }
  const total = rows.reduce((s, r) => s + toPaise(r.tds_amount), 0)
  const label = TDS_CREDIT_STATUS_INFO[move.status].label

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const r = await setTdsCreditStatus({
        items: rows.map((x) => ({ id: x.id, updatedAt: x.updated_at })),
        status: move.status,
        on: undo ? null : on,
        note: note || null,
        claimedIn: move.status === "claimed" ? claimedIn : null,
      })
      if (!r.ok) {
        setError({ message: r.fieldErrors?.claimedIn?.[0] ?? r.fieldErrors?.on?.[0] ?? r.error, ref: r.ref })
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(`${r.data.updated} ${r.data.updated === 1 ? "credit" : "credits"} marked ${label}.`)
      onClose()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const title =
    move.status === "reflected"
      ? undo
        ? "Move back to Reflected?"
        : "Mark as reflected in 26AS / AIS?"
      : move.status === "claimed"
        ? "Mark as claimed?"
        : "Move back to Expected?"

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title={title}
      description={`${rows.length} ${rows.length === 1 ? "credit" : "credits"} · ${formatINR(total)} of TDS${move.rows.length > rows.length ? ` (${move.rows.length - rows.length} selected can't move this way and are left)` : ""}`}
      onSubmit={submit}
      pending={pending}
      submitDisabled={rows.length === 0}
      submitLabel={undo ? "Move back" : `Mark ${label.toLowerCase()}`}
    >
      <div className="flex flex-col gap-4">
        <FormAlert error={error} />
        {move.status === "expected" ? (
          <p className="text-base text-text">Their statement match is removed, and they show as still to reflect.</p>
        ) : move.status === "reflected" && !undo ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.on} className="text-sm font-medium text-text">
              Showed in 26AS / AIS on
            </label>
            <DatePicker id={ids.on} value={on} onChange={setOn} max={today} />
          </div>
        ) : move.status === "claimed" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.claimed} className="text-sm font-medium text-text">
                Claimed in <span className="text-danger-text">*</span>
              </label>
              <Input id={ids.claimed} value={claimedIn} onChange={(e) => setClaimedIn(e.target.value)} maxLength={200} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.on} className="text-sm font-medium text-text">
                Claimed on
              </label>
              <DatePicker id={ids.on} value={on} onChange={setOn} max={today} />
            </div>
          </>
        ) : (
          <p className="text-base text-text">The claim is undone; they stay reflected in 26AS / AIS.</p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.note} className="text-sm font-medium text-text">
            Note
          </label>
          <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder="Checked in 26AS downloaded on 20 Oct" />
        </div>
      </div>
    </FormDialog>
  )
}

function TanDialog({ row, onClose }: { row: TdsCreditRow; onClose: () => void }) {
  const router = useRouter()
  const [tan, setTan] = React.useState("")
  const [error, setError] = React.useState<FormError | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    setFieldError(null)
    try {
      const r = await setDeductorTan({ receiptId: row.id, tan, updatedAt: row.updated_at })
      if (!r.ok) {
        if (r.fieldErrors?.tan?.[0]) setFieldError(r.fieldErrors.tan[0])
        else setError({ message: r.error, ref: r.ref })
        return
      }
      toast.success(`TAN ${r.data.tan} saved on receipt ${row.receipt_number}.`)
      onClose()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog open onOpenChange={(o) => (!o ? onClose() : undefined)} size="sm" title="Add the deductor's TAN" description={`${row.client_name} · receipt ${row.receipt_number}`} onSubmit={submit} pending={pending} submitLabel="Save TAN">
      <div className="flex flex-col gap-4">
        <FormAlert error={error} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-text">
            TAN <span className="text-danger-text">*</span>
          </label>
          <Input
            id={id}
            value={tan}
            onChange={(e) => setTan(e.target.value.toUpperCase())}
            maxLength={10}
            autoCapitalize="characters"
            placeholder="BLRA12345B"
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={`${id}-help`}
            className="font-mono"
          />
          <p id={`${id}-help`} className={fieldError ? "text-sm text-danger-text" : "text-sm text-text-muted"}>
            {fieldError ?? "The TAN the client deducted under, from their Form 16A. The 26AS import matches by it."}
          </p>
        </div>
      </div>
    </FormDialog>
  )
}
