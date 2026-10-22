"use client"

import * as React from "react"
import { CalendarClockIcon, FileClockIcon, LandmarkIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, ScaleIcon, Trash2Icon } from "lucide-react"
import { COMPLIANCE_TYPE_LABELS, SERVICE_FREQUENCY_LABELS, type ComplianceType, type ServiceFrequency } from "@/lib/domain/enums"
import { formatDate, formatDateTime } from "@/lib/format"
import { summariseParameterValue } from "@/lib/schemas/law"
import type { ConcordanceRow, DueDateRuleRow, LawChangeRow, OverrideRow, ParameterRow } from "@/lib/data/law"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import { EmptyState } from "@/components/app/empty-state"
import { MarkVerifiedButton, VerificationCell } from "@/components/settings/law/verification"
import { ConcordanceDialog, OverrideAddDialog, ParameterAddDialog, ParameterChangeDialog, RemoveOverrideDialog, RuleChangeDialog } from "@/components/settings/law/law-dialogs"

interface PageProps<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
  /** Today (IST), to tell rows in force from past ones. */
  today: string
}

const AWAITING_ROW = "bg-warning-soft/40"

function InForce({ from, to, today }: { from: string; to: string | null; today: string }) {
  const past = to !== null && to < today
  const future = from > today
  return (
    <div className="flex flex-col items-end">
      <span className="num whitespace-nowrap text-text">{to ? `${formatDate(from)} – ${formatDate(to)}` : `from ${formatDate(from)}`}</span>
      {past ? <span className="text-xs text-text-muted">Past</span> : future ? <span className="text-xs text-info-text">Starts later</span> : null}
    </div>
  )
}

function Source({ text }: { text: string | null }) {
  if (!text) return <span className="text-text-muted">—</span>
  return (
    <span className="line-clamp-2 text-sm text-text" title={text}>
      {text}
    </span>
  )
}

function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} data-row-click-ignore>
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Add" button with its dialog, for the filter bar. */
export function AddParameterButton() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Add parameter
      </Button>
      <ParameterAddDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

export function AddOverrideButton({ rules }: { rules: Array<{ code: string; title: string; form_code: string | null }> }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Record an extension
      </Button>
      <OverrideAddDialog open={open} onOpenChange={setOpen} rules={rules} />
    </>
  )
}

export function AddConcordanceButton() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Add row
      </Button>
      <ConcordanceDialog row={null} open={open} onOpenChange={setOpen} />
    </>
  )
}

// -------------------------------------------------------------------------------------------------
// Statutory parameters
// -------------------------------------------------------------------------------------------------

function ParameterActions({ row, today }: { row: ParameterRow; today: string }) {
  const [changing, setChanging] = React.useState(false)
  const ended = row.effective_to !== null && row.effective_to < today
  return (
    <div className="flex items-center justify-end gap-1" data-row-click-ignore>
      {!row.verified ? (
        <MarkVerifiedButton
          table="statutory_parameters"
          id={row.id}
          updatedAt={row.updated_at}
          what={`${row.key} = ${summariseParameterValue(row.value, 40)} from ${formatDate(row.effective_from)}`}
          source={row.source_ref}
        />
      ) : null}
      {!ended ? (
        <RowMenu label={`More for ${row.key}`}>
          <DropdownMenuItem onSelect={() => setChanging(true)}>
            <CalendarClockIcon aria-hidden="true" />
            Change from a date…
          </DropdownMenuItem>
        </RowMenu>
      ) : null}
      {changing ? <ParameterChangeDialog row={row} open={changing} onOpenChange={setChanging} /> : null}
    </div>
  )
}

export function ParametersTable({ rows, total, page, pageSize, today }: PageProps<ParameterRow>) {
  const columns: DataTableColumn<ParameterRow>[] = [
    {
      id: "key",
      header: "Parameter",
      hideable: false,
      mobile: "primary",
      width: "28%",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-text" title={r.key}>
            {r.key}
          </p>
          <p className="truncate text-xs text-text-muted">{[r.statute, r.section_ref].filter(Boolean).join(" · ") || "—"}</p>
        </div>
      ),
    },
    {
      id: "value",
      header: "Value",
      mobile: "secondary",
      cell: (r) => (
        <span className="line-clamp-2 font-mono text-sm break-all text-text" title={summariseParameterValue(r.value, 400)}>
          {summariseParameterValue(r.value, 60)}
        </span>
      ),
    },
    { id: "in_force", header: "In force", align: "right", mobile: "secondary", cell: (r) => <InForce from={r.effective_from} to={r.effective_to} today={today} /> },
    { id: "source", header: "Source", hideBelow: "xl", cell: (r) => <Source text={r.source_ref} /> },
    { id: "verified", header: "Confirmation", mobile: "trailing", cell: (r) => <VerificationCell verified={r.verified} byName={r.verified_by_name} on={r.verified_on} /> },
    { id: "actions", header: "Actions", hideable: false, align: "right", cell: (r) => <ParameterActions row={r} today={today} /> },
  ]
  return (
    <DataTable
      id="law-parameters"
      caption="Statutory parameters"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      total={total}
      page={page}
      pageSize={pageSize}
      countLabel={(n, t) => `${n} parameter row${t === 1 ? "" : "s"}`}
      rowClassName={(r) => (r.verified ? undefined : AWAITING_ROW)}
      empty={<EmptyState icon={<LandmarkIcon />} message="No statutory parameters yet. They come with the database seed; add one here if the seed hasn't run." action={<AddParameterButton />} />}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Due-date rules
// -------------------------------------------------------------------------------------------------

function RuleActions({ row, today }: { row: DueDateRuleRow; today: string }) {
  const [changing, setChanging] = React.useState(false)
  const ended = row.effective_to !== null && row.effective_to < today
  return (
    <div className="flex items-center justify-end gap-1" data-row-click-ignore>
      {!row.verified ? (
        <MarkVerifiedButton table="due_date_rules" id={row.id} updatedAt={row.updated_at} what={`${row.code} (${row.title})`} source={row.source_ref} />
      ) : null}
      {!ended ? (
        <RowMenu label={`More for ${row.code}`}>
          <DropdownMenuItem onSelect={() => setChanging(true)}>
            <CalendarClockIcon aria-hidden="true" />
            Change from a date…
          </DropdownMenuItem>
        </RowMenu>
      ) : null}
      {changing ? <RuleChangeDialog row={row} open={changing} onOpenChange={setChanging} /> : null}
    </div>
  )
}

export function RulesTable({ rows, total, page, pageSize, today }: PageProps<DueDateRuleRow>) {
  const columns: DataTableColumn<DueDateRuleRow>[] = [
    {
      id: "code",
      header: "Rule",
      hideable: false,
      mobile: "primary",
      width: "30%",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-base text-text" title={r.title}>
            {r.title}
          </p>
          <p className="truncate font-mono text-xs text-text-muted">
            {r.code}
            {r.is_active ? "" : " · switched off"}
          </p>
        </div>
      ),
    },
    {
      id: "form",
      header: "Return",
      mobile: "secondary",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-text">{r.form_code ?? COMPLIANCE_TYPE_LABELS[r.compliance_type as ComplianceType] ?? r.compliance_type}</p>
          <p className="text-xs text-text-muted">{SERVICE_FREQUENCY_LABELS[r.frequency as ServiceFrequency] ?? r.frequency}</p>
        </div>
      ),
    },
    {
      id: "rule",
      header: "Due",
      hideBelow: "lg",
      cell: (r) => (
        <span className="line-clamp-2 font-mono text-xs break-all text-text" title={JSON.stringify(r.rule)}>
          {summariseParameterValue(r.rule, 50)}
        </span>
      ),
    },
    { id: "reminder_days", header: "Reminder", align: "right", hideBelow: "xl", cell: (r) => <span className="num text-text">{r.reminder_days} d</span> },
    { id: "in_force", header: "In force", align: "right", mobile: "secondary", cell: (r) => <InForce from={r.effective_from} to={r.effective_to} today={today} /> },
    { id: "source", header: "Source", hideBelow: "xl", cell: (r) => <Source text={r.source_ref} /> },
    { id: "verified", header: "Confirmation", mobile: "trailing", cell: (r) => <VerificationCell verified={r.verified} byName={r.verified_by_name} on={r.verified_on} /> },
    { id: "actions", header: "Actions", hideable: false, align: "right", cell: (r) => <RuleActions row={r} today={today} /> },
  ]
  return (
    <DataTable
      id="law-rules"
      caption="Due-date rules"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      total={total}
      page={page}
      pageSize={pageSize}
      countLabel={(n, t) => `${n} rule${t === 1 ? "" : "s"}`}
      rowClassName={(r) => (r.verified ? undefined : AWAITING_ROW)}
      empty={<EmptyState icon={<CalendarClockIcon />} message="No due-date rules yet. They come with the database seed (the statutory calendar)." />}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Government extensions
// -------------------------------------------------------------------------------------------------

function OverrideActions({ row }: { row: OverrideRow }) {
  const [removing, setRemoving] = React.useState(false)
  return (
    <div className="flex items-center justify-end" data-row-click-ignore>
      <RowMenu label={`More for ${row.rule_code} ${row.period_label}`}>
        <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
          <Trash2Icon aria-hidden="true" />
          Remove extension…
        </DropdownMenuItem>
      </RowMenu>
      {removing ? <RemoveOverrideDialog row={row} open={removing} onOpenChange={setRemoving} /> : null}
    </div>
  )
}

export function OverridesTable({ rows, total, page, pageSize, rules }: Omit<PageProps<OverrideRow>, "today"> & { rules: Array<{ code: string; title: string; form_code: string | null }> }) {
  const columns: DataTableColumn<OverrideRow>[] = [
    {
      id: "rule",
      header: "Rule and period",
      hideable: false,
      mobile: "primary",
      width: "30%",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-base text-text">
            {r.rule_title ?? r.rule_code} · {r.period_label}
          </p>
          <p className="truncate font-mono text-xs text-text-muted">{r.rule_code}</p>
        </div>
      ),
    },
    {
      id: "dates",
      header: "Due date",
      align: "right",
      mobile: "trailing",
      cell: (r) => (
        <div className="flex flex-col items-end">
          <span className="num font-medium whitespace-nowrap text-text">{formatDate(r.extended_due)}</span>
          <span className="num text-xs whitespace-nowrap text-text-muted line-through decoration-text-muted/60">{formatDate(r.original_due)}</span>
        </div>
      ),
    },
    { id: "source", header: "Circular", mobile: "secondary", cell: (r) => <Source text={r.source_ref} /> },
    { id: "scope", header: "Covers", hideBelow: "xl", cell: (r) => <Source text={r.scope} /> },
    { id: "moved", header: "Events moved", align: "right", hideBelow: "lg", cell: (r) => <span className="num text-text">{r.moved_count.toLocaleString("en-IN")}</span> },
    {
      id: "added",
      header: "Added",
      align: "right",
      hideBelow: "xl",
      cell: (r) => (
        <div className="flex flex-col items-end">
          <span className="num text-sm whitespace-nowrap text-text">{formatDate(r.created_at)}</span>
          <span className="text-xs text-text-muted">{r.created_by_name ?? "—"}</span>
        </div>
      ),
    },
    { id: "actions", header: "Actions", hideable: false, align: "right", cell: (r) => <OverrideActions row={r} /> },
  ]
  return (
    <DataTable
      id="law-overrides"
      caption="Government extensions"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      total={total}
      page={page}
      pageSize={pageSize}
      countLabel={(n, t) => `${n} extension${t === 1 ? "" : "s"}`}
      empty={<EmptyState icon={<FileClockIcon />} message="No extensions recorded. When a circular extends a due date, record it here and the matching events move." action={<AddOverrideButton rules={rules} />} />}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Section concordance
// -------------------------------------------------------------------------------------------------

function ConcordanceActions({ row }: { row: ConcordanceRow }) {
  const [editing, setEditing] = React.useState(false)
  return (
    <div className="flex items-center justify-end gap-1" data-row-click-ignore>
      {!row.verified ? (
        <MarkVerifiedButton
          table="section_concordance"
          id={row.id}
          updatedAt={row.updated_at}
          what={`${row.topic}: ${[row.old_section, row.old_form].filter(Boolean).join(" / ") || "—"} → ${[row.new_section, row.new_form].filter(Boolean).join(" / ") || "—"}`}
          source={row.source_ref}
        />
      ) : null}
      <RowMenu label={`More for ${row.topic}`}>
        <DropdownMenuItem onSelect={() => setEditing(true)}>
          <PencilIcon aria-hidden="true" />
          Edit…
        </DropdownMenuItem>
      </RowMenu>
      {editing ? <ConcordanceDialog row={row} open={editing} onOpenChange={setEditing} /> : null}
    </div>
  )
}

function Provision({ section, form }: { section: string | null; form: string | null }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-text">{section ?? "—"}</p>
      {form ? <p className="truncate text-xs text-text-muted">{form}</p> : null}
    </div>
  )
}

export function ConcordanceTable({ rows, total, page, pageSize }: Omit<PageProps<ConcordanceRow>, "today">) {
  const columns: DataTableColumn<ConcordanceRow>[] = [
    { id: "topic", header: "Topic", hideable: false, mobile: "primary", width: "28%", cell: (r) => <span className="text-base text-text">{r.topic}</span> },
    { id: "old", header: "Income-tax Act, 1961", mobile: "secondary", cell: (r) => <Provision section={r.old_section} form={r.old_form} /> },
    { id: "new", header: "Income-tax Act, 2025", mobile: "secondary", cell: (r) => <Provision section={r.new_section} form={r.new_form} /> },
    { id: "source", header: "Source", hideBelow: "xl", cell: (r) => <Source text={r.source_ref} /> },
    { id: "verified", header: "Confirmation", mobile: "trailing", cell: (r) => <VerificationCell verified={r.verified} byName={r.verified_by_name} on={r.verified_on} /> },
    { id: "actions", header: "Actions", hideable: false, align: "right", cell: (r) => <ConcordanceActions row={r} /> },
  ]
  return (
    <DataTable
      id="law-concordance"
      caption="Section concordance"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      total={total}
      page={page}
      pageSize={pageSize}
      countLabel={(n, t) => `${n} row${t === 1 ? "" : "s"}`}
      rowClassName={(r) => (r.verified ? undefined : AWAITING_ROW)}
      empty={<EmptyState icon={<ScaleIcon />} message="No concordance rows yet. Add the 1961 ↔ 2025 mapping from the CBDT's published table." action={<AddConcordanceButton />} />}
    />
  )
}

// -------------------------------------------------------------------------------------------------
// Change log (audit rows written by the law actions)
// -------------------------------------------------------------------------------------------------

const ACTION_LABEL: Record<string, string> = {
  "law.parameter.change": "Changed a parameter from a date",
  "law.parameter.add": "Added a parameter",
  "law.verify": "Confirmed against the source",
  "law.review": "Recorded a review",
  "law.rule.change": "Changed a due-date rule from a date",
  "law.override.add": "Recorded an extension",
  "law.override.applied": "Moved events for an extension",
  "law.override.remove": "Removed an extension",
  "law.concordance.update": "Edited a concordance row",
  "law.concordance.add": "Added a concordance row",
}

function describeChange(r: LawChangeRow): string {
  const d = r.details ?? {}
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null)
  switch (r.action) {
    case "law.parameter.change":
    case "law.parameter.add": {
      const after = (d.after ?? {}) as Record<string, unknown>
      return [s("key"), after.value ? `= ${String(after.value)}` : null, after.effective_from ? `from ${formatDate(String(after.effective_from))}` : null, s("source_ref")].filter(Boolean).join(" · ")
    }
    case "law.rule.change":
      return [s("code"), s("source_ref")].filter(Boolean).join(" · ")
    case "law.override.add":
    case "law.override.remove":
      return [s("rule_code"), s("period_label"), s("extended_due") ? `to ${formatDate(s("extended_due"))}` : null, s("source_ref")].filter(Boolean).join(" · ")
    case "law.override.applied":
      return `${String(d.moved ?? 0)} event(s) moved`
    case "law.review":
      return [s("note"), typeof d.awaiting_confirmation === "number" ? `${d.awaiting_confirmation} awaiting confirmation then` : null].filter(Boolean).join(" · ")
    case "law.concordance.update":
    case "law.concordance.add":
      return s("topic") ?? ""
    case "law.verify":
      return r.resource_type ? r.resource_type.replace(/_/g, " ") : ""
    default:
      return ""
  }
}

export function ChangeLogTable({ rows, total, page, pageSize }: Omit<PageProps<LawChangeRow>, "today">) {
  const columns: DataTableColumn<LawChangeRow>[] = [
    { id: "at", header: "When", mobile: "trailing", width: "11rem", cell: (r) => <span className="num text-sm whitespace-nowrap text-text">{formatDateTime(r.at)}</span> },
    {
      id: "what",
      header: "What",
      hideable: false,
      mobile: "primary",
      cell: (r) => (
        <div className="min-w-0">
          <p className="text-base text-text">{ACTION_LABEL[r.action ?? ""] ?? r.action ?? "Change"}</p>
          <p className="line-clamp-2 text-sm break-words text-text-muted">{describeChange(r) || "—"}</p>
        </div>
      ),
    },
    { id: "who", header: "By", mobile: "secondary", cell: (r) => <span className="text-sm text-text">{r.user_email ?? "—"}</span> },
  ]
  return (
    <DataTable
      id="law-log"
      caption="Law and rules change log"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      total={total}
      page={page}
      pageSize={pageSize}
      countLabel={(n, t) => `${n} change${t === 1 ? "" : "s"}`}
      empty={<EmptyState icon={<FileClockIcon />} message="No changes yet. Every change, confirmation and review on this page is listed here." />}
    />
  )
}
