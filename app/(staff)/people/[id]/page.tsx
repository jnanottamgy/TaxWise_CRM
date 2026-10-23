import type { Metadata } from "next"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireStaff, denyAccess } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { formatDate, formatTimeAgo } from "@/lib/format"
import { PageHeader } from "@/components/app/page-header"
import { DefinitionList } from "@/components/app/definition-list"
import { MonoId } from "@/components/app/mono-id"
import { RoleBadge } from "@/components/app/role-badge"
import { ErrorBlock } from "@/components/app/error-block"
import { ShellTitle, PageGuide } from "@/components/shell/page-slots"
import { getPerson, listActiveStaff, type PersonDetail, type PersonOption } from "@/lib/data/people"
import { LoginStatusChip, PersonInitials, PresenceChip, TabNav } from "@/components/people/people-bits"
import { PersonActions } from "@/components/people/person-actions"
import { PersonProfileTab, PersonWorkTab } from "@/components/people/person-tabs-a"
import { PersonActivityTab, PersonPerformanceTab, PersonTimeTab } from "@/components/people/person-tabs-b"
import { AttendanceTab } from "@/components/attendance/attendance-tab"
import { PersonLeaveTab } from "@/components/leave/person-leave-tab"

export const metadata: Metadata = { title: "Person" }

type SearchParams = Record<string, string | string[] | undefined>

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "work", label: "Work" },
  { id: "time", label: "Time" },
  { id: "attendance", label: "Attendance" },
  { id: "leave", label: "Leave" },
  { id: "activity", label: "Activity" },
  { id: "performance", label: "Performance" },
] as const
type TabId = (typeof TABS)[number]["id"]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Person detail (§7.11.2): Profile · Work · Time · Attendance · Leave · Activity · Performance.
 * Partners and Managers open anyone; everyone else only themselves, so the people being measured
 * can see it. Actions follow §4.5 and §4.1 (Managers manage Employees only).
 */
export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const manager = can.managePeople(user.role)
  if (!manager && id !== user.employeeId) denyAccess()

  const sp = await searchParams
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab
  const tab: TabId = TABS.some((t) => t.id === rawTab) ? (rawTab as TabId) : sp.changes || sp.return_note || sp.cover ? "work" : "profile"

  let person: PersonDetail | null = null
  let staff: PersonOption[] = []
  let ref: string | null = null
  try {
    ;[person, staff] = await Promise.all([getPerson(supabase, id, user.role), manager ? listActiveStaff(supabase) : Promise.resolve([])])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/people/[id]", userId: user.id, role: user.role })
  }
  if (ref) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load this person." errorRef={ref} />
      </div>
    )
  }
  if (!person) notFound()

  const self = user.employeeId === person.id
  const crumbs = manager ? [{ label: "People", href: "/people" }, { label: person.full_name }] : [{ label: "Profile", href: "/profile" }, { label: "My record" }]
  const tabProps = { person, viewer: user, supabase, searchParams: sp }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title={self ? "Your record" : person.full_name}>
        <p>Everything about {self ? "you" : "this person"} at the firm: details, open work and covers, time, attendance, leave, activity and performance.</p>
        <p className="mt-2">Performance and attendance are shown to the person themselves too, so the people being measured can see what is measured.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={crumbs}
        className="pb-0 md:pb-0"
        title={
          <span className="inline-flex items-center gap-3">
            <PersonInitials name={person.full_name} size="lg" className="max-sm:hidden" />
            {person.full_name}
          </span>
        }
        meta={
          <>
            <RoleBadge role={person.role} />
            <LoginStatusChip status={person.login_status} onLeave={person.on_leave_today} />
            {person.login_status === "active" ? <PresenceChip status={person.presence} /> : null}
          </>
        }
        description={[person.designation, person.department].filter(Boolean).join(" · ") || undefined}
        actions={<PersonActions person={person} actor={{ role: user.role, userId: user.id }} staff={staff} autoOpenCover={sp.cover === "new" && manager} />}
      />
      <section aria-label="Key facts" className="rounded-lg border border-border bg-surface px-4 py-1 md:px-5">
        <DefinitionList
          columns={2}
          items={[
            { term: "Email", value: <MonoId value={person.email} copy label="email" /> },
            { term: "Phone", value: person.phone },
            { term: "Joined", value: person.date_of_joining ? formatDate(person.date_of_joining) : null },
            { term: "Last active", value: person.last_seen_at ? formatTimeAgo(person.last_seen_at) : person.login_status === "no_login" ? "No login yet" : "Never" },
          ]}
        />
      </section>
      <TabNav label="Person sections" active={tab} items={TABS.map((t) => ({ id: t.id, label: t.label, href: `/people/${person.id}?tab=${t.id}` }))} />
      <div className="min-w-0">
        {tab === "profile" ? <PersonProfileTab {...tabProps} /> : null}
        {tab === "work" ? <PersonWorkTab {...tabProps} /> : null}
        {tab === "time" ? <PersonTimeTab {...tabProps} /> : null}
        {tab === "attendance" ? (
          <AttendanceTab employeeId={person.id} employeeRole={person.role} viewer={user} supabase={supabase} searchParams={sp} basePath={`/people/${person.id}?tab=attendance`} />
        ) : null}
        {tab === "leave" ? <PersonLeaveTab employeeId={person.id} viewer={user} supabase={supabase} searchParams={sp} /> : null}
        {tab === "activity" ? <PersonActivityTab {...tabProps} /> : null}
        {tab === "performance" ? <PersonPerformanceTab {...tabProps} /> : null}
      </div>
    </div>
  )
}
