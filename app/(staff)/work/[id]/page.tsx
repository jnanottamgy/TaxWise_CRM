import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { can } from "@/lib/auth/roles"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { todayIST } from "@/lib/domain/fy"
import { DECLINE_REASON_LABELS, SERVICE_TYPE_LABELS, type DocumentCategory, type ServiceType } from "@/lib/domain/enums"
import { formatDate, formatDateTime, formatMinutes } from "@/lib/format"
import { getStatus } from "@/lib/status"
import { getMessagingContext, type MessagingContext } from "@/lib/data/clients"
import { getAskClientContext, getTaskDetail, getTaskFormOptions, type AskClientContext, type TaskDetailBundle } from "@/lib/data/tasks"
import { getRunningTimer, type RunningTimer } from "@/lib/data/timesheet"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { DateText } from "@/components/app/date-text"
import { PriorityChip } from "@/components/app/priority-chip"
import { StatusChip } from "@/components/app/status-chip"
import { MonoId } from "@/components/app/mono-id"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { fileHref } from "@/components/documents/doc-urls"
import { StatusMenu } from "@/components/tasks/status-control"
import { AcceptDecline } from "@/components/tasks/acceptance"
import { AskClientForData } from "@/components/tasks/ask-client"
import { TaskChecklist } from "@/components/tasks/detail/task-checklist"
import { TaskComments } from "@/components/tasks/detail/task-comments"
import { TaskAttachments } from "@/components/tasks/detail/task-attachments"
import { TaskDependencies } from "@/components/tasks/detail/task-dependencies"
import { TaskHistory } from "@/components/tasks/detail/task-history"
import { LogTimeButton, RemarksCard, TaskManageMenu, TaskTimeCard } from "@/components/tasks/detail/task-side"
import { TimerButton } from "@/components/timesheet/timer-button"
import type { TaskFormOptions } from "@/components/tasks/task-form"

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Task" }
    const s = await getSession()
    if (s.status !== "ok" || s.user.role === "client") return { title: "Task" }
    const { data } = await s.supabase.from("tasks_list").select("task_number, title").eq("id", id).maybeSingle()
    return { title: data ? `${data.task_number} · ${data.title}` : "Task" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Task" }
  }
}

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/work/[id]:${source}`, userId }) }
  }
}

const CATEGORY_BY_SERVICE: Partial<Record<ServiceType, DocumentCategory>> = {
  gst: "gst",
  income_tax: "income_tax",
  tds: "tds",
  payroll: "payroll",
  audit: "audit",
  company_law: "roc",
}

/**
 * The task (§7.6.6): header with the client, title, status and its allowed moves, assignee,
 * reviewer, due date (with relative time) and priority; then the description, checklist, comments,
 * attachments, time against the estimate, dependencies, status history and activity. Buttons:
 * Start timer · Log time · Ask client for data · Change status. A task the viewer can't see (RLS)
 * or in the recycle bin is a 404.
 */
export default async function TaskPage({ params }: Params) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const today = todayIST()
  // One clock for the page: client blocks compute "12 hours ago" from it, so hydration matches the server.
  const now = new Date().toISOString()
  const viewer = { employeeId: user.employeeId, role: user.role, today }

  let bundle: TaskDetailBundle | null
  try {
    bundle = await getTaskDetail(supabase, id, viewer)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/work/[id]:task", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={[{ label: "Work tracker", href: "/work" }, { label: "Task" }]} title="Task" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this task." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!bundle || bundle.task.deleted_at) notFound()
  const { task } = bundle
  const canManage = can.createAndAssignTasks(user.role)
  const isAssignee = Boolean(user.employeeId && task.assigned_employee_id === user.employeeId)
  const fy = await getSelectedFy()

  const [messaging, askClient, running, formOptions, people] = await Promise.all([
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
    attempt("client", user.id, () => getAskClientContext(supabase, task.client_id)),
    user.employeeId ? attempt("timer", user.id, () => getRunningTimer(supabase, user.employeeId!)) : Promise.resolve({ ok: true as const, data: null as RunningTimer | null }),
    canManage ? attempt("form", user.id, () => getTaskFormOptions(supabase, user.role)) : Promise.resolve(null),
    attempt("people", user.id, async () => {
      const { data, error } = await supabase.from("employee_directory").select("profile_id, full_name, designation, is_active").order("full_name")
      if (error) throw error
      return (data ?? []).filter((p) => p.is_active && p.profile_id).map((p) => ({ id: p.profile_id as string, name: p.full_name ?? "", designation: p.designation }))
    }),
  ])

  const client: AskClientContext | null = askClient.ok ? askClient.data : null
  const clientLabel = `${task.client_code ? `${task.client_code} · ` : ""}${task.client_name ?? "Client"}`
  const taskRefLabel = `${task.task_number} · ${task.title}`
  const options: TaskFormOptions | null =
    formOptions && formOptions.ok
      ? {
          staff: formOptions.data.staff,
          reviewers: formOptions.data.reviewers,
          templates: formOptions.data.templates.map((x) => ({ id: x.id, name: x.name, service_type: x.service_type, steps: x.steps })),
          fyOptions: fyOptions(today),
        }
      : null
  const runningRef = running.ok && running.data ? { entryId: running.data.id, taskId: running.data.task?.id ?? null, clientId: running.data.client?.id ?? null, startedAt: running.data.started_at } : null
  const m: MessagingContext | null = messaging.ok ? messaging.data : null
  const filed = task.status === "filed_done"
  const openItems = bundle.checklist.filter((c) => !c.done).map((c) => c.title)
  const movable = { id: task.id, task_number: task.task_number, title: task.title, status: task.status, service_type: task.service_type, compliance_event_id: task.compliance_event_id, updated_at: task.updated_at }
  const filing = bundle.filings[0] ?? null

  const facts = [
    {
      term: "Client",
      value: client ? (
        <Link href={`/clients/${task.client_id}?tab=tasks`} className="font-medium text-text hover:underline">
          {task.client_name}
        </Link>
      ) : (
        task.client_name
      ),
    },
    { term: "Task number", value: <MonoId value={task.task_number} copy label="Task number" /> },
    { term: "Assignee", value: task.assignee_name ?? <span className="text-text-muted">Unassigned</span> },
    { term: "Reviewer", value: task.reviewer_name ?? <span className="text-text-muted">Any Manager</span> },
    { term: "Due", value: <DateText date={task.due_date} withRelative={!filed} today={today} /> },
    { term: "Priority", value: <PriorityChip kind="task_priority" value={task.priority} /> },
    { term: "Service", value: task.service_type ? SERVICE_TYPE_LABELS[task.service_type] : null },
    { term: "FY · Period", value: [task.financial_year, task.period_label].filter(Boolean).join(" · ") || null },
    { term: "Estimate", value: task.estimated_minutes ? formatMinutes(task.estimated_minutes) : null },
    { term: "Acceptance", value: <StatusChip kind="task_acceptance" value={task.assigned_employee_id || task.acceptance_status === "declined" ? task.acceptance_status : null} /> },
    ...(bundle.event
      ? [
          {
            term: "Deadline",
            value: (
              <span>
                {bundle.event.title} · due {formatDate(bundle.event.due_date)} · <StatusChip kind="compliance_workflow" value={bundle.event.workflow_status} />
              </span>
            ),
            wide: true,
          },
        ]
      : []),
    ...(bundle.templateName ? [{ term: "Job template", value: bundle.templateName }] : []),
    ...(task.status === "on_hold" && task.on_hold_reason ? [{ term: "On hold because", value: task.on_hold_reason, wide: true }] : []),
    ...(task.escalation_level > 0 && !filed ? [{ term: "Escalated", value: `Level ${task.escalation_level}${task.escalated_at ? ` since ${formatDate(task.escalated_at)}` : ""} (${task.escalation_level === 2 ? "Partners told" : "Managers told"})` }] : []),
    ...(task.completion_date ? [{ term: "Filed on", value: formatDateTime(task.completion_date) }] : []),
    ...(filing
      ? [
          {
            term: "Filing",
            value: (
              <span className="flex flex-wrap items-center gap-x-2">
                {[filing.filing_type, filing.period, filing.filed_on ? formatDate(filing.filed_on) : null].filter(Boolean).join(" · ")}
                {filing.acknowledgement_no ? <MonoId value={filing.acknowledgement_no} copy label="Acknowledgement number" truncate={16} /> : null}
                {filing.document_id ? (
                  <a href={fileHref(filing.document_id, { mode: "preview" })} target="_blank" rel="noopener" className="text-sm font-medium text-text underline-offset-4 hover:underline">
                    Acknowledgement
                  </a>
                ) : null}
              </span>
            ),
            wide: true,
          },
        ]
      : task.filing_skipped_reason
        ? [{ term: "Filing", value: `Nothing filed: ${task.filing_skipped_reason}`, wide: true }]
        : []),
  ]

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={[{ label: "Work tracker", href: "/work" }, { label: task.task_number }]} />
      <PageGuide title="Task">
        <p>Change status moves the task along; the menu shows only the moves open to you, and why the others are closed. Sending back, reopening and putting on hold need a reason.</p>
        <p className="mt-2">Filing a return asks for the acknowledgement details and marks the client&apos;s deadline Filed. Ask client for data opens WhatsApp or Gmail with the open checklist items as the list of what&apos;s missing.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={[{ label: "Work tracker", href: "/work" }, { label: task.task_number }]}
        title={task.title}
        description={
          <>
            {client ? (
              <Link href={`/clients/${task.client_id}`} className="text-text hover:underline">
                {clientLabel}
              </Link>
            ) : (
              clientLabel
            )}
            {task.period_label ? ` · ${task.period_label}` : ""}
            {task.due_date ? (
              <>
                {" · Due "}
                <DateText date={task.due_date} withRelative={!filed} today={today} />
              </>
            ) : null}
          </>
        }
        actions={options && canManage ? <TaskManageMenu task={{ ...editable(task, clientLabel), task_number: task.task_number, title: task.title }} options={options} /> : null}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusMenu task={movable} options={bundle.nextMoves} size="default" />
        {user.employeeId ? <TimerButton task={{ id: task.id, label: taskRefLabel }} running={runningRef} /> : null}
        {user.employeeId ? <LogTimeButton task={{ id: task.id, label: taskRefLabel }} client={{ id: task.client_id, label: clientLabel }} /> : null}
        {client && m ? (
          <AskClientForData
            taskId={task.id}
            clientId={task.client_id}
            // Asking the client is the job while the task waits on their data; otherwise it stays quiet.
            variant={task.status === "data_awaited" ? "outline" : "ghost"}
            recipient={{ contact: client.contact, client: client.client }}
            facts={{
              clientName: client.clientName,
              clientCode: client.clientCode,
              taskTitle: task.title,
              period: task.period_label,
              serviceLabel: task.service_type ? SERVICE_TYPE_LABELS[task.service_type] : null,
              missing: openItems,
              dueDateText: task.due_date ? formatDate(task.due_date) : null,
              portalLink: `${env.appUrl().replace(/\/+$/, "")}/portal/documents`,
            }}
            messaging={{
              firmName: m.firmName,
              firmPhone: m.firmPhone,
              countryCode: m.countryCode,
              signatureFormat: m.signatureFormat,
              addSignature: m.addSignature,
              senderName: user.fullName,
              templates: m.templates.filter((t) => t.type === "document_reminder"),
            }}
          />
        ) : null}
      </div>

      <AcceptanceBanner bundle={bundle} isAssignee={isAssignee} canManage={canManage} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 lg:gap-6">
          <SectionCard title="Details">
            <DefinitionList items={facts} columns={2} />
            {task.description ? (
              <div className="mt-4 border-t border-border pt-4">
                <h3 className="mb-1 text-xs font-medium text-text-muted">Description</h3>
                <p className="text-base whitespace-pre-wrap text-text">{task.description}</p>
              </div>
            ) : null}
          </SectionCard>
          <TaskChecklist
            taskId={task.id}
            items={bundle.checklist}
            dueDate={task.due_date}
            today={today}
            canTick={canManage || isAssignee}
            canManage={canManage}
            templates={options?.templates ?? []}
            done={filed}
          />
          {people.ok ? (
            <TaskComments
              taskId={task.id}
              comments={bundle.comments}
              people={people.data}
              viewerId={user.id}
              canModerate={canManage}
              now={now}
            />
          ) : (
            <SectionCard title="Comments">
              <ErrorBlock message="Couldn't load the comments." errorRef={people.ref} size="compact" />
            </SectionCard>
          )}
          <TaskAttachments
            taskId={task.id}
            clientId={task.client_id}
            attachments={bundle.attachments}
            canUpload={canManage || client !== null}
            viewerId={user.id}
            canModerate={canManage}
            defaults={{ category: (task.service_type && CATEGORY_BY_SERVICE[task.service_type]) || "other", financialYear: task.financial_year ?? fy, period: task.period_label ?? "" }}
            now={now}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          <TaskTimeCard
            logged={task.logged_minutes}
            estimate={task.estimated_minutes}
            byPerson={bundle.timeByPerson}
            showPeople={canManage}
            task={{ id: task.id, label: taskRefLabel }}
            client={{ id: task.client_id, label: clientLabel }}
          />
          <RemarksCard taskId={task.id} remarks={task.remarks} updatedAt={task.updated_at} canEdit={canManage || isAssignee} />
          <TaskDependencies taskId={task.id} deps={bundle.dependencies} canManage={canManage} />
          <TaskHistory history={bundle.history} activity={bundle.activity} />
        </div>
      </div>
    </div>
  )
}

function editable(task: TaskDetailBundle["task"], clientLabel: string) {
  return {
    id: task.id,
    client_id: task.client_id,
    client_label: clientLabel,
    title: task.title,
    description: task.description,
    service_type: task.service_type,
    financial_year: task.financial_year,
    period_label: task.period_label,
    due_date: task.due_date,
    priority: task.priority,
    estimated_minutes: task.estimated_minutes,
    assigned_employee_id: task.assigned_employee_id,
    reviewer_employee_id: task.reviewer_employee_id,
    remarks: task.remarks,
    compliance_event_id: task.compliance_event_id,
    updated_at: task.updated_at,
  }
}

/** Acceptance (§7.6.3): the assignee answers; everyone else sees who it is waiting for, or why it came back. */
function AcceptanceBanner({ bundle, isAssignee, canManage }: { bundle: TaskDetailBundle; isAssignee: boolean; canManage: boolean }) {
  const t = bundle.task
  if (t.acceptance_status === "declined") {
    return (
      <div role="status" className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
        <p className="text-base font-medium text-text">
          Declined{t.declined_by_name ? ` by ${t.declined_by_name}` : ""}
          {t.declined_at ? ` on ${formatDate(t.declined_at)}` : ""}
        </p>
        <p className="mt-0.5 text-sm text-text">
          {t.decline_reason ? DECLINE_REASON_LABELS[t.decline_reason] : "No reason recorded"}
          {t.decline_note ? `: ${t.decline_note}` : ""}
        </p>
        <p className="mt-1 text-sm text-text-muted">{canManage ? "It is unassigned now. Edit the task to give it to someone else." : "A Manager will reassign it."}</p>
      </div>
    )
  }
  if (!t.assigned_employee_id) {
    return canManage ? (
      <div role="status" className="mb-4 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text">
        Nobody is assigned. Edit the task to give it to someone; they accept it before work starts.
      </div>
    ) : null
  }
  if (t.acceptance_status !== "pending") return null
  if (isAssignee) {
    return (
      <div role="status" className="mb-4 flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-base font-medium text-text">This task is waiting for you to accept it</p>
          <p className="mt-0.5 text-sm text-text">{getStatus("task_acceptance", "pending").meaning} Decline it with a reason if you can&apos;t take it on.</p>
        </div>
        <AcceptDecline task={{ id: t.id, task_number: t.task_number, title: t.title }} layout="stack" />
      </div>
    )
  }
  return (
    <div role="status" className="mb-4 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text">
      Waiting for {t.assignee_name ?? "the assignee"} to accept it{t.assigned_at ? ` (assigned ${formatDate(t.assigned_at)})` : ""}. Its status can change once they do.
    </div>
  )
}
