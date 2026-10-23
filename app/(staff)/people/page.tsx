import type { Metadata } from "next"
import { redirect, unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { todayIST } from "@/lib/domain/fy"
import { logUnexpected } from "@/lib/log"
import { parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { PEOPLE_FILTERS, PEOPLE_SORTABLE, existingTeamEmails, getTeamCounts, listDepartments, listPeople } from "@/lib/data/people"
import { LOGIN_STATUS, ROLE_SCOPE, STAFF_ROLE_VALUES } from "@/lib/schemas/people"
import { PeopleTable } from "@/components/people/people-table"
import { AddPersonDialog } from "@/components/people/add-person-dialog"
import { ImportPeopleDialog } from "@/components/people/import-people-dialog"

export const metadata: Metadata = { title: "People" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/people:${source}`, userId }) }
  }
}

/**
 * People (§7.11.1): the team with roles, logins, open work, capacity and presence. Partners and
 * Managers only (§4.1); an Employee is taken to their own page.
 */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  if (!can.managePeople(user.role)) redirect(user.employeeId ? `/people/${user.employeeId}` : "/profile")

  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: PEOPLE_SORTABLE, defaultSort: { sort: "full_name", dir: "asc" }, filters: PEOPLE_FILTERS })
  const today = todayIST()
  const [list, counts, departments, emails] = await Promise.all([
    attempt("list", user.id, () => listPeople(supabase, t, today)),
    attempt("counts", user.id, () => getTeamCounts(supabase)),
    attempt("departments", user.id, () => listDepartments(supabase)),
    attempt("emails", user.id, async () => Array.from(await existingTeamEmails(supabase))),
  ])

  const description = counts.ok
    ? [
        `${counts.data.active} active`,
        counts.data.noLogin ? `${counts.data.noLogin} without a login` : null,
        `${counts.data.onlineNow} online now`,
        counts.data.onLeaveToday ? `${counts.data.onLeaveToday} on leave today` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "The team: roles, logins, open work, capacity and who is online."

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="People">
        <p>Everyone on the team, with their role, whether they can sign in, their open tasks and how loaded they are over the next two weeks.</p>
        <p className="mt-2">Capacity is open tasks due in the next 14 days (overdue ones too) per working day left, excluding weekends, holidays and approved leave: CLEAR below 1.5 a day, BUSY from 1.5, TIGHT from 2.5, OVER from 4.</p>
        <p className="mt-2">Open a person to edit their details, reset their password, change their role, disable them, move their work, or set up cover for their clients.</p>
      </PageGuide>
      <PageHeader
        title="People"
        description={description}
        actions={
          <>
            <ImportPeopleDialog actorRole={user.role} existingEmails={emails.ok ? emails.data : []} />
            <AddPersonDialog actorRole={user.role} />
          </>
        }
      />
      <FilterBar
        searchLabel="Search people"
        searchPlaceholder="Name, email, designation or department"
        filters={[
          { id: "role", label: "Role", options: STAFF_ROLE_VALUES.map((r) => ({ value: r, label: ROLE_SCOPE[r].label })) },
          {
            id: "status",
            label: "Status",
            options: (["active", "no_login", "disabled"] as const).map((s) => ({ value: s, label: LOGIN_STATUS[s].label, tone: LOGIN_STATUS[s].tone })),
          },
          ...(departments.ok && departments.data.length ? [{ id: "department", label: "Department", options: departments.data.map((d) => ({ value: d, label: d })) }] : []),
        ]}
      />
      {list.ok ? (
        <PeopleTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} canAdd={can.manageEmployees(user.role)} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the team." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
