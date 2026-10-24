import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { CalendarClockIcon, FileTextIcon, ListChecksIcon } from "lucide-react"
import { z } from "zod"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { fyEnd, fyStart, todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { EMPTY, formatDate } from "@/lib/format"
import { getGroup, type GroupDetail } from "@/lib/data/client-groups"
import { PageHeader } from "@/components/app/page-header"
import { KpiStrip } from "@/components/app/kpi-strip"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { ShellTitle } from "@/components/shell/page-slots"
import { EditGroupDialog } from "@/components/clients/groups/group-form-dialog"
import { AddMembersDialog, DeleteGroupButton, GroupMembersTable } from "@/components/clients/groups/group-members"

export const metadata: Metadata = { title: "Client group" }

/**
 * One client group (§7.4): its clients, their combined open tasks and upcoming deadlines, and
 * (Partner/Manager) the outstanding across them and the group's statement of account for the selected
 * FY (§7.9.10). Members are added and removed here; the name and notes are edited here. Invoicing
 * stays per client.
 */
export default async function ClientGroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const { user, supabase } = await requireManagerOrPartner()
  const seesMoney = can.seeMoney(user.role)
  const today = todayIST()

  let detail: GroupDetail | null
  try {
    detail = await getGroup(supabase, id, seesMoney)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/clients/groups/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Client groups", href: "/clients/groups" }, { label: "Group" }]} title="Client group" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this group." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail) notFound()
  const { group, members, tasks, tasksTotal, deadlines, deadlinesTotal } = detail
  // "Next deadline" is the next one still ahead (the view's next_due_date), named by that event, not
  // by the soonest pending one, which may be overdue. Overdue ones are counted beside it.
  const upcoming = group.next_due_date ? deadlines.find((d) => !d.is_overdue && d.due_date === group.next_due_date) : undefined
  const overdueShown = deadlines.filter((d) => d.is_overdue).length
  const overdueLabel = overdueShown && overdueShown === deadlines.length && deadlinesTotal > deadlines.length ? `${overdueShown}+` : String(overdueShown)
  const fy = seesMoney ? await getSelectedFy() : null
  const statementHref = fy ? `/api/pdf/statement/group/${group.id}?from=${fyStart(fy)}&to=${fyEnd(fy) < today ? fyEnd(fy) : today}` : null

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <ShellTitle crumbs={[{ label: "Clients", href: "/clients" }, { label: "Client groups", href: "/clients/groups" }, { label: group.name }]} />
      <PageHeader
        breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Client groups", href: "/clients/groups" }, { label: group.name }]}
        title={group.name}
        description={group.notes ?? undefined}
        actions={
          <>
            {statementHref ? (
              <Button asChild variant="outline">
                <a href={statementHref} target="_blank" rel="noopener" title={`Statement of account for FY ${fy}`}>
                  <FileTextIcon aria-hidden="true" />
                  Statement of account
                </a>
              </Button>
            ) : null}
            <DeleteGroupButton group={{ id: group.id, name: group.name, members: group.members, updatedAt: group.updated_at }} />
            <EditGroupDialog group={{ id: group.id, name: group.name, notes: group.notes, updatedAt: group.updated_at }} />
            <AddMembersDialog groupId={group.id} groupName={group.name} />
          </>
        }
      />

      <KpiStrip
        aria-label="This group at a glance"
        items={[
          { label: "Clients", value: group.members, sub: group.members === group.active_members ? "All active" : `${group.active_members} active` },
          {
            label: "Open tasks",
            value: group.open_tasks,
            sub: group.overdue_tasks ? <span className="text-danger-text">{group.overdue_tasks} overdue</span> : "None overdue",
          },
          {
            label: "Next deadline",
            value: group.next_due_date ? formatDate(group.next_due_date) : EMPTY,
            sub:
              overdueShown || upcoming ? (
                <>
                  {overdueShown ? <span className="text-danger-text">{overdueLabel} overdue</span> : null}
                  {overdueShown && upcoming ? " · " : null}
                  {upcoming?.title ?? null}
                </>
              ) : undefined,
          },
          ...(seesMoney ? [{ label: "Outstanding", value: <Money value={group.outstanding} />, sub: "Across its clients' invoices" }] : []),
        ]}
      />

      <section aria-labelledby="group-members" className="flex min-w-0 flex-col gap-2">
        <h2 id="group-members" className="text-md font-semibold text-text">
          Clients
        </h2>
        <GroupMembersTable groupId={group.id} groupName={group.name} rows={members} today={today} seesMoney={seesMoney} />
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SectionCard
          id="group-tasks"
          title="Open tasks"
          description={tasksTotal > tasks.length ? `The ${tasks.length} due soonest of ${tasksTotal}` : undefined}
          flush
        >
          {tasks.length ? (
            <ul className="divide-y divide-border border-t border-border">
              {tasks.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/work/${t.id}`}
                    className="flex items-start justify-between gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-text">{t.title}</span>
                      <span className="block truncate text-sm text-text-muted">
                        <span className="font-mono text-[12px]">{t.task_number}</span> · {t.client_name}
                      </span>
                    </span>
                    <span className="flex flex-none flex-col items-end gap-0.5 text-sm">
                      <StatusChip kind="task_status" value={t.status} />
                      {t.due_date ? <DateText date={t.due_date} withRelative today={today} /> : <span className="text-text-muted">No due date</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 pb-4 md:px-5">
              <EmptyState size="compact" icon={<ListChecksIcon />} message={members.length ? "No open tasks for these clients." : "Add clients to see their tasks here."} />
            </div>
          )}
        </SectionCard>

        <SectionCard
          id="group-deadlines"
          title="Pending deadlines"
          description={deadlinesTotal > deadlines.length ? `The ${deadlines.length} soonest of ${deadlinesTotal}, overdue first` : "Soonest first, overdue at the top"}
          flush
        >
          {deadlines.length ? (
            <ul className="divide-y divide-border border-t border-border">
              {deadlines.map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/clients/${d.client_id}?tab=compliance`}
                    className="flex items-start justify-between gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-text">{d.title}</span>
                      <span className="block truncate text-sm text-text-muted">
                        {d.client_name}
                        {d.filing_period ? ` · ${d.filing_period}` : ""}
                      </span>
                    </span>
                    <span className={d.is_overdue ? "flex-none text-sm text-danger-text" : "flex-none text-sm"}>
                      <DateText date={d.due_date} withRelative today={today} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 pb-4 md:px-5">
              <EmptyState size="compact" icon={<CalendarClockIcon />} message={members.length ? "No pending deadlines for these clients." : "Add clients to see their deadlines here."} />
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
