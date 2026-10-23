import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { addDays, todayIST } from "@/lib/domain/fy"
import { LEAVE_TYPE_LABELS, LEAVE_TYPES } from "@/lib/domain/enums"
import { statusOptions } from "@/lib/status"
import { parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { PageGuide } from "@/components/shell/page-slots"
import { LEAVE_FILTERS, LEAVE_SORTABLE, listAway, listLeave, listPendingForApprover } from "@/lib/data/leave"
import { getEmployeeNames, listActiveStaff, type PersonOption } from "@/lib/data/people"
import { canManagePerson } from "@/lib/schemas/people"
import { TabNav } from "@/components/people/people-bits"
import { RequestLeaveDialog } from "@/components/leave/request-leave-dialog"
import { LeaveTable } from "@/components/leave/leave-table"
import { AwayList, PendingLeaveList, type AwayRow } from "@/components/leave/leave-lists"
import { PersonLeaveTab } from "@/components/leave/person-leave-tab"

export const metadata: Metadata = { title: "Leave" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/leave:${source}`, userId }) }
  }
}

const TABS = [
  { id: "requests", label: "Waiting for you" },
  { id: "away", label: "Who's away" },
  { id: "all", label: "All leave" },
  { id: "mine", label: "My leave" },
] as const

/**
 * Leave (§7.11.3). Partners and Managers: the requests waiting for them (Managers decide Employees',
 * Partners Managers' and Partners'), who is away in the next 30 days with their cover, every leave,
 * and their own. Employees: their own leave and requests (§4.1).
 */
export default async function LeavePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const today = todayIST()
  const manager = can.managePeople(user.role)

  if (!manager) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageGuide title="Leave">
          <p>Ask for leave here. Your Manager decides it (a Partner, for Managers), and you&apos;re told in your Inbox. Approved leave shows as On leave in your attendance.</p>
          <p className="mt-2">You can cancel a request any time before it is decided, and approved leave before it starts.</p>
        </PageGuide>
        <PageHeader title="Leave" description="Your leave this year and every request you've made." actions={<RequestLeaveDialog />} />
        {user.employeeId ? (
          <PersonLeaveTab employeeId={user.employeeId} viewer={user} supabase={supabase} searchParams={sp} />
        ) : (
          <div className="rounded-lg border border-border bg-surface">
            <EmptyState message="Your staff record is missing, so leave can't be requested yet. Ask a Partner." />
          </div>
        )}
      </div>
    )
  }

  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab
  const tab = TABS.some((t) => t.id === rawTab) ? (rawTab as (typeof TABS)[number]["id"]) : "requests"
  const staff = await attempt("staff", user.id, () => listActiveStaff(supabase))
  const staffList: PersonOption[] = staff.ok ? staff.data : []
  const manageable = staffList.filter((p) => p.id !== user.employeeId && canManagePerson(user.role, p.role))
  const pending = await attempt("pending", user.id, () => listPendingForApprover(supabase, user))

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageGuide title="Leave">
        <p>Managers decide Employees&apos; leave; Partners decide Managers&apos; and Partners&apos;. Nobody decides their own.</p>
        <p className="mt-2">Approving marks the days On leave in attendance, and asks who covers the person&apos;s clients while they&apos;re away (or record No cover needed). Tasks due during the leave are listed so you can move them first.</p>
      </PageGuide>
      <PageHeader
        title="Leave"
        className="pb-0 md:pb-0"
        description={pending.ok ? (pending.data.length ? `${pending.data.length} ${pending.data.length === 1 ? "request waits" : "requests wait"} for you` : "No requests waiting for you") : "Leave requests, approvals and who is away."}
        actions={<RequestLeaveDialog people={manageable.map((p) => ({ id: p.id, full_name: p.full_name }))} />}
      />
      <TabNav
        label="Leave views"
        active={tab}
        items={TABS.map((t) => ({ id: t.id, label: t.id === "requests" && pending.ok && pending.data.length ? `${t.label} (${pending.data.length})` : t.label, href: `/leave?tab=${t.id}` }))}
      />
      {tab === "requests" ? (
        <SectionCard title="Waiting for you" description="Approve or decline. After approving you're asked who covers their clients." flush>
          {pending.ok ? <PendingLeaveList rows={pending.data} actorRole={user.role} staff={staffList} /> : <ErrorBlock message="Couldn't load the requests." errorRef={pending.ref} />}
        </SectionCard>
      ) : tab === "away" ? (
        <AwaySection userId={user.id} supabase={supabase} today={today} actorRole={user.role} />
      ) : tab === "all" ? (
        <AllLeave sp={sp} today={today} user={user} supabase={supabase} staff={staffList} />
      ) : user.employeeId ? (
        <PersonLeaveTab employeeId={user.employeeId} viewer={user} supabase={supabase} searchParams={sp} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState message="Your staff record is missing. Ask a Partner." />
        </div>
      )}
    </div>
  )
}

async function AwaySection({ userId, supabase, today, actorRole }: { userId: string; supabase: Awaited<ReturnType<typeof requireStaff>>["supabase"]; today: string; actorRole: Awaited<ReturnType<typeof requireStaff>>["user"]["role"] }) {
  const away = await attempt("away", userId, async () => {
    const rows = await listAway(supabase, today, addDays(today, 30))
    const ids = rows.map((r) => r.id)
    const covers = ids.length
      ? await supabase.from("client_covers").select("leave_id, cover_employee_id").in("leave_id", ids).is("revoked_at", null).is("merged_into", null)
      : { data: [], error: null }
    if (covers.error) throw covers.error
    const names = await getEmployeeNames(supabase, (covers.data ?? []).map((c) => c.cover_employee_id))
    return rows.map(
      (r): AwayRow => ({
        ...r,
        coveredBy: Array.from(new Set((covers.data ?? []).filter((c) => c.leave_id === r.id).map((c) => names.get(c.cover_employee_id) ?? ""))).filter(Boolean),
      }),
    )
  })
  return (
    <SectionCard title="Who's away" description="Approved leave from today to 30 days ahead" flush>
      {away.ok ? <AwayList rows={away.data} actorRole={actorRole} today={today} /> : <ErrorBlock message="Couldn't load who's away." errorRef={away.ref} />}
    </SectionCard>
  )
}

async function AllLeave({
  sp,
  today,
  user,
  supabase,
  staff,
}: {
  sp: SearchParams
  today: string
  user: Awaited<ReturnType<typeof requireStaff>>["user"]
  supabase: Awaited<ReturnType<typeof requireStaff>>["supabase"]
  staff: PersonOption[]
}) {
  const t = parseTableParams(sp, { sortable: LEAVE_SORTABLE, defaultSort: { sort: "start_date", dir: "desc" }, filters: LEAVE_FILTERS })
  const list = await attempt("all", user.id, () => listLeave(supabase, t, today))
  return (
    <div className="flex flex-col">
      <FilterBar
        searchLabel="Search leave by person"
        searchPlaceholder="Name"
        filters={[
          { id: "status", label: "Status", options: statusOptions("leave_status").map((o) => ({ value: o.value, label: o.label, tone: o.tone })) },
          { id: "type", label: "Type", options: LEAVE_TYPES.map((ty) => ({ value: ty, label: LEAVE_TYPE_LABELS[ty] })) },
          { id: "when", label: "When", multi: false, options: [{ value: "upcoming", label: "Now and ahead" }, { value: "past", label: "Past" }] },
          { id: "person", label: "Person", options: staff.map((p) => ({ value: p.id, label: p.full_name })) },
        ]}
      />
      {list.ok ? (
        <LeaveTable
          rows={list.data.rows}
          total={list.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          viewer={{ role: user.role, employeeId: user.employeeId, today }}
          staff={staff}
          showPerson
          emptyMessage="No leave has been requested yet."
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the leave." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
