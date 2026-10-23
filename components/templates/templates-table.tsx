"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CopyIcon, MessageSquareTextIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Power, PowerOff, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DataTable, type DataTableColumn } from "@/components/app/data-table/data-table"
import type { SortDir } from "@/components/app/data-table/params"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { CopyButton } from "@/components/app/copy-button"
import { HandoffSheet } from "@/components/app/messaging/handoff-sheet"
import { formatDateTime } from "@/lib/format"
import { TEMPLATE_CHANNEL_LABELS, TEMPLATE_TYPE_LABELS, bodySnippet, usedVariables } from "@/lib/schemas/message-templates"
import type { MessageTemplateRow } from "@/lib/data/message-templates"
import { deleteMessageTemplate, duplicateMessageTemplate, setMessageTemplateActive } from "@/server/actions/message-templates"
import { TemplateDialog, type TemplateEditorContext, type TemplateForEdit } from "@/components/templates/template-form"
import { TemplatePreview } from "@/components/templates/template-preview"
import { runAction } from "@/components/comms/comms-ui"

/**
 * The message templates list (§7.13.4): name with the first line of the message, type, channel,
 * when it last changed, and whether it is offered when drafting. Opening a row shows the preview
 * with the sample client. Partners and Managers edit, copy, switch off and delete; Employees use
 * them (§4.1) and see only the active, non-money ones.
 */

function toEdit(t: MessageTemplateRow): TemplateForEdit {
  return { id: t.id, name: t.name, type: t.type, channel: t.channel, subject: t.subject, body: t.body, is_active: t.is_active, updated_at: t.updated_at }
}

export function TemplatesTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  dir,
  canManage,
  ctx,
  initialOpenId,
}: {
  rows: MessageTemplateRow[]
  total: number
  page: number
  pageSize: number
  sort: string | null
  dir: SortDir
  canManage: boolean
  ctx: TemplateEditorContext
  initialOpenId?: string | null
}) {
  const router = useRouter()
  const [viewing, setViewing] = React.useState<MessageTemplateRow | null>(() => rows.find((r) => r.id === initialOpenId) ?? null)
  const [editing, setEditing] = React.useState<TemplateForEdit | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState<MessageTemplateRow | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const toggle = async (t: MessageTemplateRow) => {
    setBusy(t.id)
    const done = await runAction(() => setMessageTemplateActive({ id: t.id, is_active: !t.is_active, expected_updated_at: t.updated_at }), t.is_active ? `“${t.name}” is switched off.` : `“${t.name}” is offered again.`)
    setBusy(null)
    if (done) router.refresh()
  }
  const duplicate = async (t: MessageTemplateRow) => {
    setBusy(t.id)
    const done = await runAction(() => duplicateMessageTemplate({ id: t.id }), (d) => `Copied as “${d.name}”, switched off until you make it active.`)
    setBusy(null)
    if (done) {
      setEditing({ ...toEdit(t), id: done.id, name: done.name, is_active: false, updated_at: done.updated_at })
      router.refresh()
    }
  }

  const columns: DataTableColumn<MessageTemplateRow>[] = [
    {
      id: "name",
      header: "Template",
      sortable: true,
      hideable: false,
      mobile: "primary",
      width: "40%",
      cell: (t) => (
        <button
          type="button"
          onClick={() => setViewing(t)}
          className="block w-full min-w-0 cursor-pointer text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="block truncate font-medium text-text hover:underline">{t.name}</span>
          <span className="block truncate text-sm text-text-muted">{bodySnippet(t.body)}</span>
        </button>
      ),
    },
    { id: "type", header: "Type", sortable: true, mobile: "secondary", cell: (t) => <span className="text-text">{TEMPLATE_TYPE_LABELS[t.type]}</span> },
    { id: "channel", header: "Channel", sortable: true, mobile: "secondary", cell: (t) => <span className="text-text">{TEMPLATE_CHANNEL_LABELS[t.channel]}</span> },
    {
      id: "updated_at",
      header: "Last changed",
      sortable: true,
      align: "right",
      hideBelow: "lg",
      cell: (t) => (
        <span className="inline-flex flex-col items-end">
          <DateText date={t.updated_at.slice(0, 10)} />
          <span className="text-xs text-text-muted">{t.updated_by_name ?? (t.created_by ? "" : "Firm default")}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: "Status",
      mobile: "trailing",
      cell: (t) => (
        <StatusChip
          label={t.is_active ? "Active" : "Switched off"}
          tone={t.is_active ? "success" : "muted"}
          meaning={t.is_active ? "Active: offered in the template pickers when someone drafts a message." : "Switched off: kept here, but not offered when drafting."}
        />
      ),
    },
    ...(canManage
      ? [
          {
            id: "actions",
            header: "",
            hideable: false,
            align: "right" as const,
            width: "3rem",
            cell: (t: MessageTemplateRow) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`} disabled={busy === t.id}>
                    {busy === t.id ? <Spinner /> : <MoreHorizontalIcon aria-hidden="true" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing(toEdit(t))}>
                    <PencilIcon aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void duplicate(t)}>
                    <CopyIcon aria-hidden="true" />
                    Make a copy
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void toggle(t)}>
                    {t.is_active ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
                    {t.is_active ? "Switch off" : "Make active"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setDeleting(t)} className="text-danger-text focus:text-danger-text">
                    <Trash2Icon aria-hidden="true" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]
      : []),
  ]

  const used = viewing ? usedVariables(viewing.body, viewing.channel === "whatsapp" ? null : viewing.subject) : []

  return (
    <>
      <DataTable
        id="message-templates"
        caption="Message templates"
        columns={columns}
        rows={rows}
        getRowId={(t) => t.id}
        total={total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        dir={dir}
        defaultSort={{ sort: "name", dir: "asc" }}
        countLabel={(n, count) => `${n} ${count === 1 ? "template" : "templates"}`}
        rowClassName={(t) => (t.is_active ? undefined : "text-text-muted")}
        empty={
          <EmptyState
            icon={<MessageSquareTextIcon />}
            message={canManage ? "No message templates yet. Add the wording your team uses for reminders and updates." : "No templates yet. A Manager or Partner sets them up."}
            action={
              canManage ? (
                <Button onClick={() => setCreating(true)}>
                  <PlusIcon aria-hidden="true" />
                  New template
                </Button>
              ) : undefined
            }
          />
        }
      />

      <HandoffSheet
        open={viewing !== null}
        onOpenChange={(o) => (!o ? setViewing(null) : undefined)}
        title={viewing?.name ?? "Template"}
        description={viewing ? `${TEMPLATE_TYPE_LABELS[viewing.type]} · ${TEMPLATE_CHANNEL_LABELS[viewing.channel]}` : undefined}
        footer={
          <>
            {viewing ? <CopyButton value={viewing.channel === "whatsapp" || !viewing.subject ? viewing.body : `${viewing.subject}\n\n${viewing.body}`} label="the template text" showText className="mr-auto" /> : null}
            <Button type="button" variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
            {canManage && viewing ? (
              <Button
                type="button"
                onClick={() => {
                  setEditing(toEdit(viewing))
                  setViewing(null)
                }}
              >
                <PencilIcon aria-hidden="true" />
                Edit
              </Button>
            ) : null}
          </>
        }
      >
        {viewing ? (
          <div className="flex flex-col gap-4">
            <TemplatePreview channel={viewing.channel} subject={viewing.subject} body={viewing.body} values={ctx.values} signature={ctx.signature} senderName={ctx.senderName} />
            <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-text-muted">Variables</dt>
              <dd className="min-w-0 font-mono text-[13px] break-words text-text">{used.length ? used.map((v) => `{{${v}}}`).join(" ") : "None"}</dd>
              <dt className="text-text-muted">Status</dt>
              <dd className="text-text">{viewing.is_active ? "Active: offered when drafting" : "Switched off"}</dd>
              <dt className="text-text-muted">Added by</dt>
              <dd className="text-text">{viewing.created_by ? (viewing.created_by_name ?? "A former colleague") : "Firm default"}</dd>
              <dt className="text-text-muted">Last changed</dt>
              <dd className="num text-text tabular-nums">
                {formatDateTime(viewing.updated_at)}
                {viewing.updated_by_name ? ` by ${viewing.updated_by_name}` : ""}
              </dd>
            </dl>
          </div>
        ) : null}
      </HandoffSheet>

      {creating ? <TemplateDialog open={creating} onOpenChange={setCreating} ctx={ctx} /> : null}
      {editing ? <TemplateDialog key={editing.id} open onOpenChange={(o) => (!o ? setEditing(null) : undefined)} template={editing} ctx={ctx} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description="It leaves this list and the template pickers. Messages already written from it keep their text. To keep it for later, switch it off instead."
        confirmLabel="Delete template"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          const done = await runAction(() => deleteMessageTemplate({ id: deleting.id }), "Template deleted.")
          if (!done) return false
          setDeleting(null)
          router.refresh()
        }}
      />
    </>
  )
}
