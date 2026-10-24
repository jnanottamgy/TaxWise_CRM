"use client"

import * as React from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { InboxIcon, PencilIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { FormDialog, FormSheet } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { DefinitionList } from "@/components/app/definition-list"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { useActionForm } from "@/hooks/use-action-form"
import { EMPTY, formatDate, formatDateTime } from "@/lib/format"
import { istDateOf } from "@/lib/domain/fy"
import {
  DATA_REQUEST_CHANNELS,
  DATA_REQUEST_CHANNEL_LABELS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_STATUS_INFO,
  DATA_REQUEST_TYPES,
  DATA_REQUEST_TYPE_HINTS,
  DATA_REQUEST_TYPE_LABELS,
  DATA_SUBJECT_TYPES,
  DATA_SUBJECT_TYPE_LABELS,
  STATUTORY_RETENTION_REASONS,
  isClosedRequestStatus,
  retainedExplanation,
  type DataRequestChannel,
  type DataRequestStatus,
  type DataRequestType,
  type DataSubjectType,
  type RetentionReasonKey,
} from "@/lib/domain/dpdp"
import { DataRequestSchema, DataRequestStatusSchema } from "@/lib/schemas/dpdp"
import { saveDataRequest, setDataRequestStatus } from "@/server/actions/data-requests"
import { searchAuditClients } from "@/server/actions/audits"
import type { DataRequestRow } from "@/lib/data/dpdp"

type Choice = { value: string; label: string }

function statusChip(r: Pick<DataRequestRow, "status" | "is_overdue">) {
  const info = DATA_REQUEST_STATUS_INFO[(r.status ?? "open") as DataRequestStatus]
  if (r.is_overdue) return <StatusChip label="Overdue" tone="danger" meaning="Past the due date and still open. Answer it and record the response." />
  return info ? <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} /> : <span>{r.status}</span>
}

function RequestDialog({ onClose, row, partners, today }: { onClose: () => void; row: DataRequestRow | null; partners: Choice[]; today: string }) {
  const router = useRouter()
  const f = useActionForm(DataRequestSchema, saveDataRequest, {
    defaultValues: {
      id: row?.id ?? "",
      updatedAt: row?.updated_at ?? "",
      subject: row?.subject ?? "",
      subjectType: (row?.subject_type as DataSubjectType | null) ?? "client_contact",
      contact: row?.contact ?? "",
      clientId: row?.client_id ?? "",
      type: (row?.type as DataRequestType | null) ?? "access",
      receivedOn: row?.received_at ? istDateOf(row.received_at) : today,
      channel: (row?.channel as DataRequestChannel | null) ?? "email",
      details: row?.details ?? "",
      handledBy: row?.handled_by ?? "",
    },
    successMessage: row ? "Request updated" : "Request recorded",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const type = f.form.watch("type") as DataRequestType
  const loadClients = React.useCallback(async (q: string): Promise<ComboOption[]> => {
    const r = await searchAuditClients({ q })
    return r.ok ? r.data : []
  }, [])
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title={row ? "Data request" : "Record a data request"}
      description="A data principal exercising a right under the DPDP Act 2023. The due date follows from the type and the day it was received."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={row ? "Save" : "Record request"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={f.control} name="type" label="Request" required options={DATA_REQUEST_TYPES.map((t) => ({ value: t, label: DATA_REQUEST_TYPE_LABELS[t] }))} helper={DATA_REQUEST_TYPE_HINTS[type]} className="md:col-span-2" />
        <TextField control={f.control} name="subject" label="From" required autoComplete="off" placeholder="The person's name" />
        <SelectField control={f.control} name="subjectType" label="Who they are to us" required options={DATA_SUBJECT_TYPES.map((t) => ({ value: t, label: DATA_SUBJECT_TYPE_LABELS[t] }))} />
        <TextField control={f.control} name="contact" label="Contact" autoComplete="off" placeholder="Email or phone to reply to" />
        <ComboboxField control={f.control} name="clientId" label="Client it relates to" loadOptions={loadClients} placeholder="None" searchPlaceholder="Name or client code" />
        <DateField control={f.control} name="receivedOn" label="Received on" required max={today} />
        <SelectField control={f.control} name="channel" label="Received by" required options={DATA_REQUEST_CHANNELS.map((c) => ({ value: c, label: DATA_REQUEST_CHANNEL_LABELS[c] }))} />
        <SelectField control={f.control} name="handledBy" label="Handled by" options={partners} placeholder="Not assigned" />
        <TextareaField control={f.control} name="details" label="What they asked for" rows={3} className="md:col-span-2" helper="In their words where you can. Verify who is asking before you share or change anything." />
      </div>
    </FormDialog>
  )
}

function RetentionPicker({ value, onPick }: { value: string; onPick: (text: string) => void }) {
  const [keys, setKeys] = React.useState<RetentionReasonKey[]>([])
  const toggle = (k: RetentionReasonKey, on: boolean) => {
    const next = on ? [...keys, k] : keys.filter((x) => x !== k)
    setKeys(next)
    onPick(retainedExplanation(next))
  }
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5">
      <legend className="sr-only">Records the law requires us to keep</legend>
      <p className="text-sm font-medium text-text">Statutory retention overrides erasure. Tick what we must keep:</p>
      {STATUTORY_RETENTION_REASONS.map((r) => (
        <label key={r.key} className="flex items-start gap-2 text-sm text-text">
          <Checkbox checked={keys.includes(r.key)} onCheckedChange={(v) => toggle(r.key, v === true)} className="mt-0.5" />
          <span>
            {r.label}
            <span className="block text-xs text-text-muted">{r.detail}</span>
          </span>
        </label>
      ))}
      {value ? null : <p className="text-xs text-text-muted">With nothing ticked the reply says nothing is retained.</p>}
    </fieldset>
  )
}

function StatusForm({ row, onDone }: { row: DataRequestRow; onDone: () => void }) {
  const router = useRouter()
  const f = useActionForm(DataRequestStatusSchema, setDataRequestStatus, {
    defaultValues: {
      id: row.id ?? "",
      updatedAt: row.updated_at ?? "",
      type: (row.type as DataRequestType) ?? "access",
      status: (row.status === "open" ? "in_progress" : (row.status as DataRequestStatus)) ?? "in_progress",
      response: row.response ?? "",
      retainedExplanation: row.retained_explanation ?? "",
    },
    successMessage: (d) => (d.closed ? "Request closed" : "Status updated"),
    onSuccess: () => {
      onDone()
      router.refresh()
    },
  })
  const status = f.form.watch("status") as DataRequestStatus
  const retained = f.form.watch("retainedExplanation") as string
  const closing = isClosedRequestStatus(status)
  return (
    <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
      <FormAlert state={f} />
      <SelectField control={f.control} name="status" label="Status" required options={DATA_REQUEST_STATUSES.map((s) => ({ value: s, label: DATA_REQUEST_STATUS_INFO[s].label }))} helper={DATA_REQUEST_STATUS_INFO[status]?.meaning} />
      <TextareaField control={f.control} name="response" label="Response to the requester" required={closing && status !== "withdrawn"} rows={4} helper="What was done or given, and when. Closing needs it." />
      {row.type === "erasure" ? (
        <>
          <RetentionPicker value={retained} onPick={(t) => f.form.setValue("retainedExplanation", t, { shouldDirty: true, shouldValidate: true })} />
          <TextareaField control={f.control} name="retainedExplanation" label="What is retained and why" required={status === "completed" || status === "rejected"} rows={4} />
        </>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
          {closing ? "Close the request" : "Save status"}
        </Button>
      </div>
    </form>
  )
}

function RequestSheet({ row, onClose, canEdit, onEdit, today }: { row: DataRequestRow; onClose: () => void; canEdit: boolean; onEdit: () => void; today: string }) {
  return (
    <FormSheet
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={`${DATA_REQUEST_TYPE_LABELS[(row.type ?? "access") as DataRequestType]}: ${row.subject ?? ""}`}
      description={row.due_by ? `Due ${formatDate(row.due_by)}` : undefined}
      footer={
        <div className="ml-auto flex gap-2">
          {canEdit && !isClosedRequestStatus(row.status ?? "") ? (
            <Button type="button" variant="outline" onClick={onEdit}>
              <PencilIcon aria-hidden="true" />
              Edit details
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          {statusChip(row)}
          {row.due_by && row.is_open ? <DateText date={row.due_by} withRelative today={today} /> : null}
        </div>
        <DefinitionList
          items={[
            { term: "From", value: `${row.subject ?? EMPTY}${row.subject_type ? ` · ${DATA_SUBJECT_TYPE_LABELS[row.subject_type as DataSubjectType] ?? row.subject_type}` : ""}` },
            { term: "Contact", value: row.contact ?? EMPTY },
            { term: "Client", value: row.client_name ?? EMPTY },
            { term: "Received", value: `${row.received_at ? formatDateTime(row.received_at) : EMPTY}${row.channel ? ` · ${DATA_REQUEST_CHANNEL_LABELS[row.channel as DataRequestChannel] ?? row.channel}` : ""}` },
            { term: "Handled by", value: row.handled_by_name ?? <span className="text-text-muted">Not assigned</span> },
            ...(row.closed_at ? [{ term: "Closed", value: formatDateTime(row.closed_at) }] : []),
          ]}
        />
        {row.details ? (
          <div>
            <p className="text-sm font-medium text-text">What they asked for</p>
            <p className="mt-1 text-sm whitespace-pre-line text-text">{row.details}</p>
          </div>
        ) : null}
        {canEdit ? (
          <div className="border-t border-border pt-4">
            <StatusForm row={row} onDone={onClose} />
          </div>
        ) : (
          <>
            {row.response ? (
              <div>
                <p className="text-sm font-medium text-text">Response</p>
                <p className="mt-1 text-sm whitespace-pre-line text-text">{row.response}</p>
              </div>
            ) : null}
            {row.retained_explanation ? (
              <div>
                <p className="text-sm font-medium text-text">Retained, and why</p>
                <p className="mt-1 text-sm whitespace-pre-line text-text">{row.retained_explanation}</p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </FormSheet>
  )
}

/**
 * Data principals' requests (§6.10): access, correction, erasure, grievance and nomination, with the
 * due date and status; the open ones also wait in the Partners' inbox (§7.17). Partners record and
 * answer them; Managers read (§7.15.4). A row opens the request: its details, and the status with
 * the response, and for an erasure what statutory retention keeps back and why.
 */
export function DataRequestsTable(props: { rows: DataRequestRow[]; total: number; page: number; pageSize: number; sort: string | null; dir: SortDir; today: string; canEdit: boolean; partners: Choice[]; focus: DataRequestRow | null }) {
  const { rows, total, page, pageSize, sort, dir, today, canEdit, partners, focus } = props
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [editing, setEditing] = React.useState<DataRequestRow | "new" | null>(null)
  const [viewId, setViewId] = React.useState<string | null>(focus?.id ?? null)
  const viewing = viewId ? (rows.find((r) => r.id === viewId) ?? (focus?.id === viewId ? focus : null)) : null
  const closeView = () => {
    setViewId(null)
    if (sp?.get("request")) {
      const p = new URLSearchParams(sp.toString())
      p.delete("request")
      router.replace(`${pathname}?${p.toString()}`, { scroll: false })
    }
  }
  const columns = React.useMemo<DataTableColumn<DataRequestRow>[]>(
    () => [
      {
        id: "subject",
        header: "From",
        sortable: true,
        hideable: false,
        mobile: "primary",
        width: "26%",
        cell: (r) => (
          <button type="button" onClick={() => setViewId(r.id)} className="inline-flex min-w-0 cursor-pointer flex-col text-left leading-5 hover:underline">
            <span className="truncate text-text">{r.subject}</span>
            <span className="truncate text-xs text-text-muted">{r.subject_type ? (DATA_SUBJECT_TYPE_LABELS[r.subject_type as DataSubjectType] ?? r.subject_type) : EMPTY}</span>
          </button>
        ),
        mobileCell: (r) => r.subject,
      },
      { id: "type", header: "Request", sortable: true, mobile: "secondary", cell: (r) => DATA_REQUEST_TYPE_LABELS[(r.type ?? "access") as DataRequestType] ?? r.type },
      { id: "received_at", header: "Received", sortable: true, align: "right", hideBelow: "lg", cell: (r) => <DateText date={r.received_at} /> },
      {
        id: "due_by",
        header: "Due",
        sortable: true,
        align: "right",
        mobile: "secondary",
        cell: (r) => (r.due_by ? <DateText date={r.due_by} withRelative={Boolean(r.is_open)} stacked today={today} /> : <span className="text-text-muted">{EMPTY}</span>),
        mobileCell: (r) => (r.due_by ? <DateText date={r.due_by} withRelative={Boolean(r.is_open)} today={today} /> : EMPTY),
      },
      { id: "status", header: "Status", sortable: true, mobile: "trailing", cell: (r) => statusChip(r) },
      { id: "handled_by_name", header: "Handled by", hideBelow: "xl", cell: (r) => (r.handled_by_name ? r.handled_by_name : <span className="text-text-muted">{EMPTY}</span>) },
    ],
    [today]
  )
  return (
    <>
      <DataTable
        id="data-requests"
        caption="Data requests"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id ?? ""}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "due_by", dir: "asc" }}
        countLabel={(n, t) => `${n} ${t === 1 ? "request" : "requests"}`}
        rowClassName={(r) => (r.is_open ? undefined : "text-text-muted")}
        toolbar={
          canEdit ? (
            <Button type="button" size="sm" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" />
              Record a request
            </Button>
          ) : undefined
        }
        empty={
          <EmptyState
            icon={<InboxIcon />}
            message="No data requests yet. Record one when a person asks to see, correct or erase their data, complains, or nominates someone."
            action={
              canEdit ? (
                <Button type="button" onClick={() => setEditing("new")}>
                  <PlusIcon aria-hidden="true" />
                  Record a request
                </Button>
              ) : undefined
            }
          />
        }
      />
      {viewing && !editing ? <RequestSheet row={viewing} onClose={closeView} canEdit={canEdit} onEdit={() => setEditing(viewing)} today={today} /> : null}
      {editing ? <RequestDialog onClose={() => setEditing(null)} row={editing === "new" ? null : editing} partners={partners} today={today} /> : null}
    </>
  )
}
