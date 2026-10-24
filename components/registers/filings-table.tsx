"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { HistoryIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { MonoId } from "@/components/app/mono-id"
import { DateText } from "@/components/app/date-text"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, TextareaField, TextField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { EMPTY } from "@/lib/format"
import { recentFinancialYears, todayIST } from "@/lib/domain/fy"
import { FILING_ORIGIN_LABEL, UpdateFilingSchema } from "@/lib/schemas/registers"
import type { FilingRow } from "@/lib/data/registers"
import { deleteInheritedFiling, updateInheritedFiling } from "@/server/actions/filing-history"
import { ImportFilingsDialog } from "@/components/registers/import-filings-dialog"
import { RowMenu, toastResult } from "@/components/registers/shared"

function EditFilingDialog({ open, onOpenChange, row }: { open: boolean; onOpenChange: (open: boolean) => void; row: FilingRow }) {
  const router = useRouter()
  const today = todayIST()
  const years = recentFinancialYears(today, 12)
  if (!years.includes(row.financial_year)) years.push(row.financial_year)
  const f = useActionForm(UpdateFilingSchema, updateInheritedFiling, {
    defaultValues: {
      id: row.id,
      updatedAt: row.updated_at,
      financialYear: row.financial_year,
      filingType: row.filing_type,
      period: row.period ?? "",
      filedOn: row.filed_on ?? "",
      acknowledgementNo: row.acknowledgement_no ?? "",
      filedByExternal: row.filed_by_external ?? "",
      notes: row.notes ?? "",
    },
    successMessage: "Prior filing corrected",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Correct a prior filing" description={`${row.client_name} · filed by ${row.filed_by_external}`} onSubmit={f.onSubmit} pending={f.pending} dirty={f.form.formState.isDirty} submitLabel="Save changes">
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={f.control} name="financialYear" label="FY" required options={years.map((y) => ({ value: y, label: `FY ${y}` }))} />
        <TextField control={f.control} name="filingType" label="Form" required autoCapitalize="characters" helper="GSTR-3B, ITR-6, 24Q, AOC-4…" />
        <TextField control={f.control} name="period" label="Period" placeholder="Mar 2025, Q4 2024-25" />
        <DateField control={f.control} name="filedOn" label="Filed on" max={today} />
        <TextField control={f.control} name="acknowledgementNo" label="Acknowledgement no." spellCheck={false} helper="ARN, acknowledgement number or SRN." />
        <TextField control={f.control} name="filedByExternal" label="Previous firm" required />
      </div>
      <TextareaField control={f.control} name="notes" label="Notes" className="mt-4" rows={2} />
    </FormDialog>
  )
}

/**
 * Filing history (§7.15.2): every filing on record, by us (from the task or deadline it closed) or
 * inherited from a previous CA (imported), with FY, form, period, filed on (and whether it met the
 * due date), acknowledgement no. and who filed it. Partners and Managers correct or remove an
 * inherited record; the firm's own filings are changed where they were recorded.
 */
export function FilingsTable(props: {
  rows: FilingRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  canManage: boolean
  showClient?: boolean
  fixedClient?: { id: string; name: string } | null
  compact?: boolean
}) {
  const { rows, canManage, showClient = true, fixedClient = null, compact = false } = props
  const router = useRouter()
  const [dialog, setDialog] = React.useState<{ kind: "edit" | "delete"; row: FilingRow } | null>(null)

  const columns = React.useMemo<DataTableColumn<FilingRow>[]>(() => {
    const cols: DataTableColumn<FilingRow>[] = []
    if (showClient) {
      cols.push({
        id: "client_name",
        header: "Client",
        sortable: !compact,
        hideable: false,
        width: "22%",
        mobile: "secondary",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5" title={`${r.client_code} · ${r.client_name}`}>
            <span className="truncate">{r.client_name}</span>
            <span className="text-xs text-text-muted">{r.client_code}</span>
          </span>
        ),
        mobileCell: (r) => r.client_name,
      })
    }
    cols.push(
      {
        id: "filing_type",
        header: "Form",
        sortable: !compact,
        hideable: false,
        mobile: "primary",
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-col leading-5">
            <span className="truncate font-medium text-text">{r.filing_type}</span>
            {r.period ? <span className="text-xs text-text-muted">{r.period}</span> : null}
          </span>
        ),
        mobileCell: (r) => `${r.filing_type}${r.period ? ` · ${r.period}` : ""}`,
      },
      { id: "financial_year", header: "FY", sortable: !compact, mobile: "secondary", cell: (r) => <span className="num">{r.financial_year}</span>, mobileCell: (r) => `FY ${r.financial_year}` },
      {
        id: "filed_on",
        header: "Filed on",
        sortable: !compact,
        align: "right",
        mobile: "trailing",
        cell: (r) => (
          <span className="inline-flex flex-col items-end leading-5">
            <DateText date={r.filed_on} />
            {r.on_time === false && r.event_due_date ? (
              <span className="text-xs text-danger-text">
                After the due date
              </span>
            ) : r.on_time === true ? (
              <span className="text-xs text-text-muted">On time</span>
            ) : null}
          </span>
        ),
        mobileCell: (r) => <DateText date={r.filed_on} />,
      },
      { id: "acknowledgement_no", header: "Acknowledgement", hideBelow: "lg", cell: (r) => <MonoId value={r.acknowledgement_no} copy label="acknowledgement number" truncate={16} /> },
      {
        id: "origin",
        header: "Filed by",
        mobile: "secondary",
        cell: (r) =>
          r.origin === "inherited" ? (
            <span className="inline-flex min-w-0 flex-col leading-5">
              <span className="text-text">{FILING_ORIGIN_LABEL.inherited}</span>
              <span className="truncate text-xs text-text-muted">{r.filed_by_external}</span>
            </span>
          ) : (
            <span className="inline-flex min-w-0 flex-col leading-5">
              <span className="text-text">{FILING_ORIGIN_LABEL.ours}</span>
              {r.task_id && r.task_number ? (
                <Link href={`/work/${r.task_id}`} className="text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                  Task {r.task_number}
                </Link>
              ) : r.created_by_name ? (
                <span className="truncate text-xs text-text-muted">{r.created_by_name}</span>
              ) : null}
            </span>
          ),
        mobileCell: (r) => (r.origin === "inherited" ? `Inherited from ${r.filed_by_external}` : FILING_ORIGIN_LABEL.ours),
      },
      { id: "notes", header: "Notes", defaultHidden: true, cell: (r) => (r.notes ? <span className="truncate text-text-muted">{r.notes}</span> : <span className="text-text-muted">{EMPTY}</span>) },
    )
    if (canManage) {
      cols.push({
        id: "actions",
        header: "Actions",
        align: "right",
        hideable: false,
        mobile: "trailing",
        width: "3.5rem",
        cell: (r) =>
          r.origin === "inherited" ? (
            <RowMenu
              label={`Actions for ${r.filing_type} FY ${r.financial_year}`}
              items={[
                { key: "edit", label: "Correct it", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setDialog({ kind: "edit", row: r }) },
                { key: "delete", label: "Remove it", icon: <Trash2Icon aria-hidden="true" />, onSelect: () => setDialog({ kind: "delete", row: r }), danger: true },
              ]}
            />
          ) : null,
      })
    }
    return cols
  }, [showClient, canManage, compact])

  const d = dialog
  return (
    <>
      <DataTable
        id={showClient ? "register-filings" : "client-filings"}
        caption="Filing history"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        sort={props.sort}
        dir={props.dir}
        defaultSort={{ sort: "filed_on", dir: "desc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "filing" : "filings"}`}
        columnChooser={!compact}
        maxHeight={compact ? "none" : "viewport"}
        empty={
          <EmptyState
            icon={<HistoryIcon />}
            message={fixedClient ? "No filings on record for this client yet. Filings made through the work tracker show here; a previous CA's can be imported." : "No filings on record yet. Filings recorded on tasks and deadlines show here, and a new client's history from a previous CA can be imported."}
            action={canManage && !compact ? <ImportFilingsDialog fixedClient={fixedClient} variant="default" /> : undefined}
          />
        }
      />
      {d?.kind === "edit" ? <EditFilingDialog key={d.row.id} open onOpenChange={(o) => !o && setDialog(null)} row={d.row} /> : null}
      <ConfirmDialog
        open={d?.kind === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={d ? `Remove ${d.row.filing_type}${d.row.period ? ` ${d.row.period}` : ""}, FY ${d.row.financial_year}?` : "Remove this filing?"}
        description="The imported record leaves the client's filing history. A UDIN linked to it stays in the register without the link."
        confirmLabel="Remove filing"
        destructive
        onConfirm={async () => {
          if (!d) return
          const r = await deleteInheritedFiling({ id: d.row.id, updatedAt: d.row.updated_at })
          if (!toastResult(r, "Prior filing removed")) return false
          setDialog(null)
          router.refresh()
        }}
      />
    </>
  )
}
