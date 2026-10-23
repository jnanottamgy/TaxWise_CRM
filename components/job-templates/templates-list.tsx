"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronDownIcon, LayoutTemplateIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/app/empty-state"
import { FilteredEmpty } from "@/components/app/filtered-empty"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { formatNumber } from "@/lib/format"
import { offsetLabel, stepsInDateOrder } from "@/lib/schemas/job-templates"
import type { JobTemplateRow } from "@/lib/data/job-templates"
import { deleteJobTemplate, setJobTemplateActive } from "@/server/actions/job-templates"
import { TemplateDialog, type TemplateForEdit } from "@/components/job-templates/template-form"
import { toastResult } from "@/components/tasks/task-ui"

/**
 * The job templates (§7.6.2; §4.1 "Employees use only"): each with its service, steps, lead days and
 * how many tasks used it. Opening a row shows its steps in date order. Partners and Managers create,
 * edit, deactivate and delete; Employees read them to apply them through their Manager.
 */

export type TemplateWithItems = JobTemplateRow & { items: TemplateForEdit["items"] }

export function TemplatesList({ templates, canManage, filtered }: { templates: TemplateWithItems[]; canManage: boolean; filtered: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<TemplateForEdit | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState<TemplateWithItems | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState<string | null>(null)

  const toggleActive = async (t: TemplateWithItems) => {
    setBusy(t.id)
    try {
      const r = await setJobTemplateActive({ id: t.id, is_active: !t.is_active, expected_updated_at: t.updated_at })
      if (toastResult(r, t.is_active ? `“${t.name}” deactivated.` : `“${t.name}” is active again.`)) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section aria-label="Job templates" className="overflow-hidden rounded-lg border border-border bg-surface">
        {templates.length === 0 ? (
          filtered ? (
            <FilteredEmpty />
          ) : (
            <EmptyState
              icon={<LayoutTemplateIcon />}
              message={canManage ? "No job templates yet. A template is a list of steps dated from the job's due date." : "No job templates yet. A Manager or Partner sets them up."}
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <PlusIcon aria-hidden="true" />
                    New template
                  </Button>
                ) : undefined
              }
            />
          )
        ) : (
          <ul>
            {templates.map((t) => {
              const expanded = open === t.id
              const panel = `tpl-${t.id}`
              return (
                <li key={t.id} className="border-b border-border/70 last:border-b-0">
                  <div className="flex items-center gap-3 px-4 py-3 md:px-5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panel}
                      onClick={() => setOpen(expanded ? null : t.id)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <ChevronDownIcon aria-hidden="true" className={cn("size-4 flex-none text-text-muted transition-transform duration-150", expanded && "rotate-180")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-medium text-text">{t.name}</span>
                        <span className="block truncate text-sm text-text-muted">
                          {SERVICE_TYPE_LABELS[t.service_type]} · {formatNumber(t.steps)} {t.steps === 1 ? "step" : "steps"}
                          {t.default_lead_days !== null ? ` · starts ${t.default_lead_days} ${t.default_lead_days === 1 ? "day" : "days"} ahead` : ""}
                          {` · used on ${formatNumber(t.used)} ${t.used === 1 ? "task" : "tasks"}`}
                        </span>
                      </span>
                    </button>
                    <StatusChip label={t.is_active ? "Active" : "Inactive"} tone={t.is_active ? "success" : "muted"} meaning={t.is_active ? "Active: it can be applied to tasks and recurring tasks." : "Inactive: kept on the tasks that used it, but it can't be applied again."} />
                    {canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`} disabled={busy === t.id}>
                            {busy === t.id ? <Spinner /> : <MoreHorizontalIcon aria-hidden="true" />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing({ ...t, items: t.items })}>
                            <PencilIcon aria-hidden="true" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void toggleActive(t)}>{t.is_active ? "Deactivate" : "Make active"}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setDeleting(t)} className="text-danger-text focus:text-danger-text">
                            <Trash2Icon aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  {expanded ? (
                    <div id={panel} className="border-t border-border/70 bg-surface-2/40 px-4 py-3 md:px-5">
                      {t.description ? <p className="mb-2 text-sm text-text">{t.description}</p> : null}
                      <ol className="flex flex-col divide-y divide-border/70">
                        {stepsInDateOrder(t.items).map((s) => (
                          <li key={s.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                            <span className="min-w-0">
                              <span className="block text-base text-text">{s.title}</span>
                              {s.description ? <span className="block text-sm text-text-muted">{s.description}</span> : null}
                            </span>
                            <span className="num flex-none text-sm text-text-muted tabular-nums">{offsetLabel(s.offset_days)}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {creating ? <TemplateDialog open={creating} onOpenChange={setCreating} /> : null}
      {editing ? <TemplateDialog open={Boolean(editing)} onOpenChange={(o) => (!o ? setEditing(null) : undefined)} template={editing} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description={`It leaves this list. ${deleting?.used ? `The ${deleting.used} ${deleting.used === 1 ? "task" : "tasks"} that used it keep their checklists.` : "No task has used it."} To keep it for the record, deactivate it instead.`}
        confirmLabel="Delete template"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          const r = await deleteJobTemplate({ id: deleting.id })
          if (!toastResult(r, "Template deleted.")) return false
          setDeleting(null)
          router.refresh()
        }}
      />
    </>
  )
}
