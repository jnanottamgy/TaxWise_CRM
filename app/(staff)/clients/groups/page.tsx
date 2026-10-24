import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { GROUP_SORTABLE } from "@/lib/schemas/client-groups"
import { listGroups } from "@/lib/data/client-groups"
import { formatCount, parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { GroupsTable } from "@/components/clients/groups/groups-table"
import { NewGroupDialog } from "@/components/clients/groups/group-form-dialog"

export const metadata: Metadata = { title: "Client groups" }

type SearchParams = Record<string, string | string[] | undefined>

/**
 * Client groups (§7.4): families and group companies managed together, with combined open tasks,
 * the next deadline and (Partner/Manager) outstanding. Searched, sorted and paged in SQL.
 */
export default async function ClientGroupsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const seesMoney = can.seeMoney(user.role)
  const t = parseTableParams(await searchParams, { sortable: GROUP_SORTABLE, defaultSort: { sort: "name", dir: "asc" } })

  let list: { ok: true; rows: Awaited<ReturnType<typeof listGroups>>["rows"]; total: number } | { ok: false; ref: string }
  try {
    const r = await listGroups(supabase, t, seesMoney)
    list = { ok: true, rows: r.rows, total: r.total }
  } catch (err) {
    unstable_rethrow(err)
    list = { ok: false, ref: logUnexpected(err, { source: "page:/clients/groups", userId: user.id }) }
  }

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Client groups">
        <p>A group is a family or a set of group companies. Its page shows the open tasks, deadlines and dues of all its clients together.</p>
        <p className="mt-2">A client is in one group at a time. Invoicing stays per client.</p>
      </PageGuide>
      <PageHeader
        breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Client groups" }]}
        title="Client groups"
        description={list.ok ? `${formatCount(list.total)} ${list.total === 1 ? "group" : "groups"} · families and group companies managed together` : "Families and group companies managed together."}
        actions={<NewGroupDialog />}
      />
      <FilterBar searchLabel="Search groups" searchPlaceholder="Group name or notes" filters={[]} />
      {list.ok ? (
        <GroupsTable rows={list.rows} total={list.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={todayIST()} now={new Date().toISOString()} seesMoney={seesMoney} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the client groups." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
