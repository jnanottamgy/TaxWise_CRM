"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowDownIcon, ArrowUpIcon, LayoutTemplateIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { checklistItemDue, checklistProgress } from "@/lib/schemas/tasks"
import { addChecklistItem, applyJobTemplate, deleteChecklistItem, reorderChecklist, toggleChecklistItem } from "@/server/actions/task-checklist"
import { ThinBar, toastResult } from "@/components/tasks/task-ui"

/**
 * The task's checklist (§7.6.6 "checklist (progress bar)"): the assignee ticks items; Partners and
 * Managers add, reorder and remove them, or apply a job template, whose steps carry a date worked
 * out from the task's due date and the step's offset (§7.6.2).
 */

export type ChecklistRow = { id: string; title: string; done: boolean; due_offset_days: number | null; sort_order: number }

export function TaskChecklist({
  taskId,
  items,
  dueDate,
  today,
  canTick,
  canManage,
  templates,
  done: isFiled,
}: {
  taskId: string
  items: ChecklistRow[]
  dueDate: string | null
  today: string
  canTick: boolean
  canManage: boolean
  templates: Array<{ id: string; name: string; steps: number }>
  /** Filed work: step dates don't count down any more. */
  done: boolean
}) {
  const router = useRouter()
  const [local, setLocal] = React.useState(items)
  const [adding, setAdding] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [template, setTemplate] = React.useState("")
  // Fresh server data replaces the optimistic copy (the "reset state when a prop changes" pattern).
  const [seen, setSeen] = React.useState(items)
  if (seen !== items) {
    setSeen(items)
    setLocal(items)
  }

  const p = checklistProgress(local.filter((i) => i.done).length, local.length)

  const toggle = async (item: ChecklistRow, next: boolean) => {
    setLocal((l) => l.map((i) => (i.id === item.id ? { ...i, done: next } : i)))
    const r = await toggleChecklistItem({ id: item.id, done: next })
    if (!toastResult(r)) setLocal((l) => l.map((i) => (i.id === item.id ? { ...i, done: !next } : i)))
    else router.refresh()
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!adding.trim()) return
    setBusy("add")
    try {
      const r = await addChecklistItem({ task_id: taskId, title: adding.trim() })
      if (toastResult(r)) {
        setAdding("")
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  const remove = async (item: ChecklistRow) => {
    setBusy(item.id)
    try {
      const r = await deleteChecklistItem({ id: item.id })
      if (toastResult(r, "Item removed.")) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const move = async (index: number, delta: -1 | 1) => {
    const next = [...local]
    const j = index + delta
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    setLocal(next)
    const r = await reorderChecklist({ task_id: taskId, ids: next.map((i) => i.id) })
    if (!toastResult(r)) setLocal(local)
  }

  const apply = async () => {
    if (!template) return
    setBusy("template")
    try {
      const r = await applyJobTemplate({ task_id: taskId, template_id: template })
      if (toastResult(r)) {
        toast.success(r.data.added ? `Added ${r.data.added} ${r.data.added === 1 ? "step" : "steps"} from “${r.data.template_name}”.` : `Every step of “${r.data.template_name}” is already on the checklist.`)
        setTemplate("")
        router.refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <SectionCard
      title="Checklist"
      description={local.length ? `${p.done} of ${p.total} done` : undefined}
      action={local.length ? <span className="num text-sm text-text-muted tabular-nums">{p.percent}%</span> : null}
      flush
    >
      {local.length ? (
        <div className="px-4 pb-3 md:px-5">
          <ThinBar percent={p.percent} tone={p.percent === 100 ? "success" : "primary"} label={`Checklist ${p.done} of ${p.total} done`} />
        </div>
      ) : null}
      {local.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" message={canManage ? "No checklist yet. Add items or apply a job template." : "No checklist on this task."} />
        </div>
      ) : (
        <ul className="border-t border-border">
          {local.map((item, i) => {
            const due = checklistItemDue(dueDate, item.due_offset_days)
            const id = `check-${item.id}`
            return (
              <li key={item.id} className="group/item flex min-h-11 items-center gap-3 border-b border-border/70 px-4 py-1.5 last:border-b-0 md:px-5">
                <Checkbox id={id} checked={item.done} disabled={!canTick} onCheckedChange={(v) => void toggle(item, v === true)} aria-describedby={due ? `${id}-due` : undefined} />
                <label htmlFor={id} className={cn("min-w-0 flex-1 text-base", canTick && "cursor-pointer", item.done ? "text-text-muted line-through decoration-text-muted/60" : "text-text")}>
                  {item.title}
                </label>
                {due ? (
                  <span id={`${id}-due`} className="flex-none text-xs">
                    <DateText date={due} withRelative={!item.done && !isFiled} today={today} />
                  </span>
                ) : null}
                {canManage ? (
                  <span className="flex flex-none items-center opacity-100 md:opacity-0 md:group-hover/item:opacity-100 md:group-focus-within/item:opacity-100">
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move “${item.title}” up`} disabled={i === 0} onClick={() => void move(i, -1)}>
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move “${item.title}” down`} disabled={i === local.length - 1} onClick={() => void move(i, 1)}>
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove “${item.title}”`} disabled={busy === item.id} onClick={() => void remove(item)}>
                      {busy === item.id ? <Spinner /> : <Trash2Icon aria-hidden="true" />}
                    </Button>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {canManage ? (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 md:px-5">
          <form onSubmit={add} className="flex items-center gap-2">
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add an item" aria-label="New checklist item" maxLength={300} />
            <Button type="submit" variant="outline" size="sm" disabled={!adding.trim() || busy === "add"} aria-busy={busy === "add"}>
              {busy === "add" ? <Spinner /> : <PlusIcon aria-hidden="true" />}
              Add
            </Button>
          </form>
          {templates.length ? (
            <div className="flex items-center gap-2 [&>[data-slot=native-select-wrapper]]:min-w-0 [&>[data-slot=native-select-wrapper]]:flex-1">
              <NativeSelect value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Job template to apply" size="sm" className="w-full">
                <NativeSelectOption value="">Apply a job template…</NativeSelectOption>
                {templates.map((t) => (
                  <NativeSelectOption key={t.id} value={t.id}>
                    {t.name} · {t.steps} {t.steps === 1 ? "step" : "steps"}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button type="button" variant="outline" size="sm" disabled={!template || busy === "template"} onClick={apply} aria-busy={busy === "template"}>
                {busy === "template" ? <Spinner /> : <LayoutTemplateIcon aria-hidden="true" />}
                Apply
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  )
}
