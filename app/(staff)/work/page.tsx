import type { Metadata } from "next"
import { redirect, unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { getSelectedFy, fyOptions } from "@/lib/fy-context"
import { todayIST } from "@/lib/domain/fy"
import { SERVICE_TYPE_LABELS, SERVICE_TYPES, TASK_STATUSES } from "@/lib/domain/enums"
import { statusOptions } from "@/lib/status"
import { formatNumber } from "@/lib/format"
import { parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { PageGuide } from "@/components/shell/page-slots"
import {
  DUE_WINDOW_LABELS,
  DUE_WINDOWS,
  EMPLOYEE_DEFAULT_QUERY,
  ME,
  NONE,
  OPEN_TASK_STATUSES,
  WORK_FILTERS,
  WORK_SORTABLE,
  monthGrid,
  periodOptionsForFy,
  readMonthParam,
  readWorkView,
} from "@/lib/schemas/tasks"
import {
  getTaskFormOptions,
  getWorkSummary,
  listBoard,
  listCalendar,
  listReviewQueue,
  listTasks,
  listWorkViews,
  searchClientOptions,
  getClientOption,
  type WorkViewer,
} from "@/lib/data/tasks"
import { listStaffOptions } from "@/lib/data/clients"
import { TasksTable } from "@/components/tasks/tasks-table"
import { TaskBoard } from "@/components/tasks/task-board"
import { TaskCalendar } from "@/components/tasks/task-calendar"
import { WorkViewTabs } from "@/components/tasks/work-view-tabs"
import { WorkViewsMenu } from "@/components/tasks/work-views"
import { NewTaskButton } from "@/components/tasks/new-task-button"
import type { TaskFormOptions } from "@/components/tasks/task-form"

export const metadata: Metadata = { title: "Work tracker" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/work:${source}`, userId }) }
  }
}

function toParams(sp: SearchParams): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one)
  }
  return p
}

/**
 * The work tracker (§7.6.1): "What needs doing next, and what's late?" Table (default), Board,
 * Calendar and My review queue over the same filters (status, assignee, reviewer, client, service,
 * priority, due window, acceptance, FY / period, has blockers), all applied in SQL under the
 * viewer's RLS. Partners and Managers see every task and create, assign and bulk-change them; an
 * Employee sees the tasks assigned to them, that they review, or of their clients (§4.1), and lands
 * on their own open tasks.
 */
export default async function WorkPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  if (user.role === "employee" && Object.keys(sp).length === 0) redirect(`/work?${EMPLOYEE_DEFAULT_QUERY}`)

  const view = readWorkView(readParam(sp, "view"))
  const t = parseTableParams(sp, { sortable: WORK_SORTABLE, defaultSort: { sort: "due_date", dir: "asc" }, filters: WORK_FILTERS })
  const today = todayIST()
  const fy = await getSelectedFy()
  const canManage = can.createAndAssignTasks(user.role)
  const viewer: WorkViewer = { employeeId: user.employeeId, role: user.role, today }
  const month = readMonthParam(readParam(sp, "month"), today)
  const grid = monthGrid(month)

  const [summary, views, staff, formOptions, clients, main] = await Promise.all([
    attempt("summary", user.id, () => getWorkSummary(supabase, viewer)),
    attempt("views", user.id, () => listWorkViews(supabase, user.id)),
    attempt("staff", user.id, () => listStaffOptions(supabase, user.role)),
    canManage ? attempt("form", user.id, () => getTaskFormOptions(supabase, user.role)) : Promise.resolve(null),
    attempt("clients", user.id, async () => {
      const list = await searchClientOptions(supabase, "", 1000)
      const wanted = (t.filters.client ?? []).filter((id) => !list.some((c) => c.value === id))
      for (const id of wanted.slice(0, 5)) {
        const c = await getClientOption(supabase, id).catch(() => null)
        if (c) list.push(c)
      }
      return list
    }),
    attempt(view, user.id, async () => {
      switch (view) {
        case "board":
          return { kind: "board" as const, ...(await listBoard(supabase, t.q, t.filters, viewer)) }
        case "calendar":
          return { kind: "calendar" as const, ...(await listCalendar(supabase, t.q, t.filters, viewer, grid[0][0], grid[grid.length - 1][6])) }
        case "review":
          return { kind: "review" as const, ...(await listReviewQueue(supabase, t, viewer)) }
        default:
          return { kind: "table" as const, ...(await listTasks(supabase, t, viewer)) }
      }
    }),
  ])

  const people = staff.ok ? staff.data : []
  const reviewers = formOptions && formOptions.ok ? formOptions.data.reviewers : people.filter((p) => p.role === "partner" || p.role === "manager")
  const options: TaskFormOptions | null =
    formOptions && formOptions.ok
      ? {
          staff: formOptions.data.staff,
          reviewers: formOptions.data.reviewers,
          templates: formOptions.data.templates.map((x) => ({ id: x.id, name: x.name, service_type: x.service_type, steps: x.steps })),
          fyOptions: fyOptions(today),
        }
      : null

  // "New task" for one client (Client 360 quick action, the client list's row action):
  // /work?new=1&client=<id> opens the dialog with that client filled in.
  const prefillId = readParam(sp, "new") === "1" && t.filters.client?.length === 1 ? t.filters.client[0] : null
  const prefill = prefillId && clients.ok ? clients.data.find((c) => c.value === prefillId) : null
  const prefillClient = prefill ? { id: prefill.value, label: prefill.description ? `${prefill.description} · ${prefill.label}` : prefill.label } : null

  const yearFilter = t.filters.year?.[0] ?? fy
  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: statusOptions("task_status") },
    {
      id: "assignee",
      label: "Assignee",
      searchable: true,
      options: [{ value: ME, label: "Me" }, { value: NONE, label: "Unassigned" }, ...people.filter((p) => p.id !== user.employeeId).map((p) => ({ value: p.id, label: p.name }))],
    },
    {
      id: "reviewer",
      label: "Reviewer",
      searchable: true,
      options: [{ value: ME, label: "Me" }, { value: NONE, label: "No named reviewer" }, ...reviewers.filter((p) => p.id !== user.employeeId).map((p) => ({ value: p.id, label: p.name }))],
    },
    ...(clients.ok && clients.data.length ? [{ id: "client", label: "Client", searchable: true, options: clients.data.map((c) => ({ value: c.value, label: c.label })) }] : []),
    { id: "service", label: "Service", options: SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] })) },
    { id: "priority", label: "Priority", options: statusOptions("task_priority") },
    { id: "due", label: "Due", multi: false, options: DUE_WINDOWS.map((d) => ({ value: d, label: DUE_WINDOW_LABELS[d] })) },
    { id: "acceptance", label: "Acceptance", options: statusOptions("task_acceptance") },
    { id: "year", label: "FY", multi: false, options: fyOptions(today).map((y) => ({ value: y, label: `FY ${y}` })) },
    { id: "period", label: "Period", multi: false, searchable: true, options: periodOptionsForFy(yearFilter).map((p) => ({ value: p, label: p })) },
    { id: "blockers", label: "Blockers", multi: false, options: [{ value: "yes", label: "Has open blockers" }, { value: "no", label: "No open blockers" }] },
  ]

  const mineQ = user.role === "employee" ? { assignee: [ME] } : {}
  const open = OPEN_TASK_STATUSES as string[]
  const kpis = summary.ok
    ? [
        { label: user.role === "employee" ? "My open tasks" : "Open tasks", value: formatNumber(summary.data.open), href: tableHref("/work", { filters: { ...mineQ, status: open } }) },
        { label: "Overdue", value: formatNumber(summary.data.overdue), href: tableHref("/work", { filters: { ...mineQ, due: ["overdue"] } }) },
        { label: "Due this week", value: formatNumber(summary.data.dueThisWeek), href: tableHref("/work", { filters: { ...mineQ, due: ["this_week"], status: open } }) },
        { label: "Data awaited", value: formatNumber(summary.data.dataAwaited), href: tableHref("/work", { filters: { ...mineQ, status: ["data_awaited"] } }) },
        { label: "Waiting for acceptance", value: formatNumber(summary.data.waiting), href: tableHref("/work", { filters: { ...mineQ, acceptance: ["pending"] } }) },
      ]
    : null

  const params = toParams(sp)
  const emptyMessage = canManage
    ? "No tasks yet. Create the first one, or set up recurring tasks from Job templates."
    : "Nothing is assigned to you yet. New work shows here once a Manager assigns it."

  const tableParams = toParams(sp)
  tableParams.delete("view")
  tableParams.delete("month")
  const viewAllHref: Record<string, string> = {}
  for (const s of TASK_STATUSES) viewAllHref[s] = tableHref("/work", { filters: { status: [s] } }, tableParams)

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title={canManage ? "Work tracker" : "My tasks"}>
        <p>Every task has a client, a status and, usually, a due date. The relative date beside it turns amber three days ahead and red once it is overdue.</p>
        <p className="mt-2">
          A newly assigned task waits for its assignee to accept it. Status changes follow the firm&apos;s rules: a reason is needed to send work back, reopen it or put it on hold; Employees submit work Under review and a Manager or Partner files it, never their own; and a task waits while anything it&apos;s blocked by isn&apos;t Filed/Done.
        </p>
        <p className="mt-2">On the board, drag a card to another column, or use its menu. The FY filter is separate from the FY in the top bar, because open work carries over between years.</p>
      </PageGuide>
      <PageHeader
        title={canManage ? "Work tracker" : "My tasks"}
        description={canManage ? "Every task in the firm, with who has it, what it's waiting on and when it's due." : "Tasks assigned to you, waiting for your review, and your clients' work."}
        actions={options ? <NewTaskButton options={options} defaultFy={fy} client={prefillClient} /> : null}
      />
      {kpis ? <KpiStrip items={kpis} className="mb-4" aria-label="Work at a glance" /> : null}
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center md:justify-between">
        <WorkViewTabs active={view} params={params} reviewCount={summary.ok ? summary.data.reviewQueue : null} />
        {views.ok ? <WorkViewsMenu views={views.data} canShare={canManage} /> : null}
      </div>
      <FilterBar searchLabel="Search tasks" searchPlaceholder="Title, task number, client or period" filters={view === "review" ? filters.filter((f) => f.id !== "status" && f.id !== "reviewer") : filters} />

      {!main.ok ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the tasks." errorRef={main.ref} />
        </div>
      ) : main.data.kind === "board" ? (
        <TaskBoard columns={main.data.columns} viewer={{ role: user.role, employeeId: user.employeeId }} today={today} viewAllHref={viewAllHref} />
      ) : main.data.kind === "calendar" ? (
        <TaskCalendar
          month={month}
          rows={main.data.rows}
          today={today}
          undated={main.data.undated}
          truncated={main.data.truncated}
          hrefFor={(m) => {
            const p = toParams(sp)
            p.set("view", "calendar")
            p.set("month", m)
            return `/work?${p.toString()}`
          }}
        />
      ) : main.data.kind === "review" ? (
        <TasksTable
          rows={main.data.rows}
          total={main.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          today={today}
          canManage={false}
          staff={people.map((p) => ({ id: p.id, name: p.name, designation: p.designation, role: p.role }))}
          reviewers={reviewers.map((p) => ({ id: p.id, name: p.name, designation: p.designation, role: p.role }))}
          caption="My review queue"
          emptyMessage="Nothing is waiting for your review. Work submitted Under review to you, or to any Manager, shows here."
        />
      ) : (
        <TasksTable
          rows={main.data.rows}
          total={main.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          today={today}
          canManage={canManage}
          staff={people.map((p) => ({ id: p.id, name: p.name, designation: p.designation, role: p.role }))}
          reviewers={reviewers.map((p) => ({ id: p.id, name: p.name, designation: p.designation, role: p.role }))}
          emptyMessage={emptyMessage}
          emptyAction={options ? <NewTaskButton options={options} defaultFy={fy} autoOpen={false} /> : undefined}
        />
      )}
    </div>
  )
}
