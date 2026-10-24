import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ArrowRightIcon } from "lucide-react"
import type { ClientTabProps } from "@/components/client360/types"
import { cn } from "@/lib/utils"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { todayIST } from "@/lib/domain/fy"
import { formatNumber } from "@/lib/format"
import { readParam } from "@/components/app/data-table/params"
import { SectionCard } from "@/components/app/section-card"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { getTaskFormOptions, listClientTasks } from "@/lib/data/tasks"
import { listAutomations } from "@/lib/data/job-templates"
import { getRunningTimer } from "@/lib/data/timesheet"
import { TaskList } from "@/components/tasks/task-list"
import { NewTaskButton } from "@/components/tasks/new-task-button"
import { AutomationsList } from "@/components/job-templates/automations-list"
import { NewAutomationButton } from "@/components/job-templates/automation-form"
import type { RunningRef } from "@/components/timesheet/timer-button"

/**
 * Client 360 → Tasks (§7.3.3): this client's work, open first (by due date), with Filed and All a
 * click away, each row with its one action (Accept / Decline, or Start timer); "New task" with the
 * client filled in (`?apply_template=1`, Client 360's "Apply job template", opens it with the
 * template picker first); and, for Partners and Managers, the client's recurring tasks (§7.6.7). Uses the
 * `t*` search params so it never collides with the page's. Never throws: each block shows its own
 * error with the Ref.
 */

const PAGE_SIZE = 20
const STATUSES = ["open", "filed", "all"] as const
type TabStatus = (typeof STATUSES)[number]

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `client360:tasks:${source}`, userId }) }
  }
}

export default async function ClientTasksTab({ clientId, user, supabase, searchParams }: ClientTabProps) {
  const rawStatus = readParam(searchParams, "tstatus")
  const status: TabStatus = (STATUSES as readonly string[]).includes(rawStatus ?? "") ? (rawStatus as TabStatus) : "open"
  const page = Math.max(1, Math.min(10_000, Number(readParam(searchParams, "tpage")) || 1))
  const today = todayIST()
  const canManage = can.createAndAssignTasks(user.role)

  const [tasks, client, running, form, automations, fy] = await Promise.all([
    attempt("list", user.id, () => listClientTasks(supabase, clientId, { status, page, pageSize: PAGE_SIZE })),
    attempt("client", user.id, async () => {
      const { data, error } = await supabase.from("clients").select("display_name, client_code").eq("id", clientId).maybeSingle()
      if (error) throw error
      return data
    }),
    user.employeeId ? attempt("timer", user.id, () => getRunningTimer(supabase, user.employeeId!)) : Promise.resolve(null),
    canManage ? attempt("form", user.id, () => getTaskFormOptions(supabase, user.role)) : Promise.resolve(null),
    canManage ? attempt("automations", user.id, () => listAutomations(supabase, { clientId })) : Promise.resolve(null),
    getSelectedFy().catch(() => null),
  ])

  const label = client.ok && client.data ? `${client.data.client_code} · ${client.data.display_name}` : "This client"
  const runningRef: RunningRef = running && running.ok && running.data ? { entryId: running.data.id, taskId: running.data.task?.id ?? null, clientId: running.data.client?.id ?? null, startedAt: running.data.started_at } : null
  const taskOptions =
    form && form.ok
      ? { staff: form.data.staff, reviewers: form.data.reviewers, templates: form.data.templates.map((t) => ({ id: t.id, name: t.name, service_type: t.service_type, steps: t.steps })), fyOptions: fyOptions(today) }
      : null
  const autoOptions =
    form && form.ok
      ? { staff: form.data.staff, reviewers: form.data.reviewers, templates: form.data.templates.map((t) => ({ id: t.id, name: t.name, service_type: t.service_type, default_lead_days: t.default_lead_days })) }
      : null

  const href = (patch: { tstatus?: TabStatus; tpage?: number }) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(searchParams)) {
      if (v === undefined || k === "tstatus" || k === "tpage") continue
      for (const one of Array.isArray(v) ? v : [v]) p.append(k, one)
    }
    p.set("tab", "tasks")
    const s = patch.tstatus ?? status
    if (s !== "open") p.set("tstatus", s)
    if (patch.tpage && patch.tpage > 1) p.set("tpage", String(patch.tpage))
    return `/clients/${clientId}?${p.toString()}`
  }

  const counts = tasks.ok ? tasks.data.counts : null
  const pages = tasks.ok ? Math.max(1, Math.ceil(tasks.data.total / PAGE_SIZE)) : 1

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <SectionCard
        title="Tasks"
        description={counts ? `${formatNumber(counts.open)} open${counts.overdue ? ` · ${formatNumber(counts.overdue)} overdue` : ""} · ${formatNumber(counts.filed)} filed` : undefined}
        action={
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/work?client=${clientId}`}>
                Work tracker
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
            {taskOptions ? <NewTaskButton options={taskOptions} defaultFy={fy ?? fyOptions(today)[1]} client={{ id: clientId, label }} openParam="apply_template" size="sm" variant="outline" /> : null}
          </div>
        }
      >
        <nav aria-label="Which tasks" className="mb-2">
          <ul className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5">
            {STATUSES.map((s) => (
              <li key={s}>
                <Link
                  href={href({ tstatus: s })}
                  scroll={false}
                  aria-current={status === s ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10",
                    status === s ? "bg-surface text-text ring-1 ring-border" : "text-text-muted hover:text-text",
                  )}
                >
                  {s === "open" ? "Open" : s === "filed" ? "Filed" : "All"}
                  {counts ? (
                    <span className="num font-normal text-text-muted tabular-nums">{formatNumber(s === "open" ? counts.open : s === "filed" ? counts.filed : counts.open + counts.filed)}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {tasks.ok ? (
          <>
            <TaskList
              rows={tasks.data.rows}
              today={today}
              running={runningRef}
              viewerEmployeeId={user.employeeId}
              showClient={false}
              emptyMessage={status === "open" ? "No open tasks for this client." : status === "filed" ? "Nothing filed for this client yet." : "No tasks for this client yet."}
            />
            {pages > 1 ? (
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-sm">
                <span className="num text-text-muted tabular-nums">
                  Page {page} of {pages}
                </span>
                <span className="flex gap-2">
                  <Button asChild variant="outline" size="sm" aria-disabled={page <= 1} className={page <= 1 ? "pointer-events-none opacity-60" : undefined}>
                    <Link href={href({ tpage: page - 1 })} scroll={false}>
                      Previous
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm" aria-disabled={page >= pages} className={page >= pages ? "pointer-events-none opacity-60" : undefined}>
                    <Link href={href({ tpage: page + 1 })} scroll={false}>
                      Next
                    </Link>
                  </Button>
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <ErrorBlock message="Couldn't load this client's tasks." errorRef={tasks.ref} size="compact" />
        )}
      </SectionCard>

      {canManage ? (
        <SectionCard
          title="Recurring tasks"
          description="Created for this client every period."
          action={autoOptions && automations?.ok && automations.data.length ? <NewAutomationButton options={autoOptions} client={{ id: clientId, label }} size="sm" variant="outline" /> : null}
          flush
        >
          {automations && automations.ok && autoOptions ? (
            <AutomationsList automations={automations.data} options={autoOptions} client={{ id: clientId, label }} showClient={false} />
          ) : (
            <div className="px-4 pb-4 md:px-5">
              <ErrorBlock message="Couldn't load the recurring tasks." errorRef={automations && !automations.ok ? automations.ref : form && !form.ok ? form.ref : null} size="compact" />
            </div>
          )}
        </SectionCard>
      ) : null}
    </div>
  )
}
