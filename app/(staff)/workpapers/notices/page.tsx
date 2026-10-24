import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getStatus } from "@/lib/status"
import { NOTICE_STATUSES } from "@/lib/domain/enums"
import { NOTICE_ATTENTION, NOTICE_ATTENTION_LABEL, NOTICE_LIST_FILTERS, NOTICE_LIST_SORTABLE, TAX_AREAS, TAX_AREA_LABEL } from "@/lib/schemas/notices"
import { getNoticeCounts, getNoticeFormContext, listNotices } from "@/lib/data/notices"
import { formatCount, parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { ClientScopeChip } from "@/components/workpapers/notices/client-scope-chip"
import { NoticesTable } from "@/components/workpapers/notices/notices-table"
import { NewNoticeButton } from "@/components/workpapers/notices/new-notice-button"
import type { Tone } from "@/components/app/tones"

export const metadata: Metadata = { title: "Notices" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/workpapers/notices:${source}`, userId }) }
  }
}

/**
 * The notices and litigation register (§7.8.4): "Which notices need a reply, a hearing or an appeal,
 * and which are late?" The figures lead (replies overdue in red, due this week, hearings this week,
 * appeals still to file), then the register: searched, filtered and sorted in SQL, soonest next date
 * first. Staff who can see the client (Employees: their own clients, §4.1, RLS).
 */
export default async function NoticesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: NOTICE_LIST_SORTABLE, defaultSort: { sort: "next_action_date", dir: "asc" }, filters: NOTICE_LIST_FILTERS })
  const today = todayIST()
  const clientId = t.filters.client?.[0] ?? null

  const [list, counts, context, client] = await Promise.all([
    attempt("list", user.id, () => listNotices(supabase, t, { today, viewerEmployeeId: user.employeeId })),
    attempt("counts", user.id, () => getNoticeCounts(supabase, today)),
    attempt("context", user.id, () => getNoticeFormContext(supabase, user, today)),
    clientId
      ? attempt("client", user.id, async () => {
          const { data, error } = await supabase.from("clients").select("id, display_name, client_code").eq("id", clientId).maybeSingle()
          if (error) throw error
          return data ? { id: data.id, label: `${data.client_code} · ${data.display_name}` } : null
        })
      : Promise.resolve(null),
  ])

  const mp = user.role === "partner" || user.role === "manager"
  const filters: FilterDef[] = [
    {
      id: "status",
      label: "Status",
      options: [
        { value: "all_open", label: "All open" },
        ...NOTICE_STATUSES.map((s) => ({ value: s, label: getStatus("notice_status", s).label, tone: getStatus("notice_status", s).tone as Tone })),
        { value: "all_closed", label: "All closed" },
      ],
    },
    { id: "attention", label: "Needs attention", options: NOTICE_ATTENTION.map((a) => ({ value: a, label: NOTICE_ATTENTION_LABEL[a] })) },
    { id: "area", label: "Area", options: TAX_AREAS.map((a) => ({ value: a, label: TAX_AREA_LABEL[a] })) },
    {
      id: "assigned",
      label: "Assigned to",
      multi: false,
      searchable: mp,
      options: [
        { value: "me", label: "Me" },
        { value: "none", label: "Unassigned" },
        ...(mp && context.ok ? context.data.staff.filter((s) => s.value !== user.employeeId) : []),
      ],
    },
  ]

  const c = counts.ok ? counts.data : null
  const href = (key: string, value: string) => tableHref("/workpapers/notices", { filters: { [key]: [value] }, page: 1 }, sp)
  const fixedClient = client && client.ok && client.data ? client.data : null
  const description = list.ok ? `${formatCount(list.data.total)} ${list.data.total === 1 ? "notice" : "notices"}${fixedClient ? ` for ${fixedClient.label}` : ""}` : "Every notice, its reply, hearings and any appeal."
  const newButton = context.ok ? <NewNoticeButton context={context.data} today={today} fixedClient={fixedClient} defaultAssignee={mp ? null : user.employeeId} defaultOpen={readParam(sp, "new") === "1"} /> : null

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={[{ label: "Workpapers", href: "/workpapers" }, { label: "Notices" }]} />
      <PageGuide title="Notices">
        <p>Log each notice a client receives with its reply due date. Reminders go to the person it is assigned to 7 and 2 days before the reply is due and before a hearing; a reply that is late is flagged to the Managers.</p>
        <p className="mt-2">
          When a notice closes against the client, record whether they will appeal. The last day to appeal is worked out from the order date and the periods on the Law &amp; rules page, and an appeal task is
          created with that date.
        </p>
      </PageGuide>
      <PageHeader title="Notices" description={description} actions={newButton} />

      <KpiStrip
        lead
        className="mb-4"
        items={[
          {
            label: "Replies overdue",
            value: c ? <span className={c.replyOverdue ? "text-danger-text" : undefined}>{formatCount(c.replyOverdue)}</span> : "—",
            sub: c ? (c.replyOverdue ? "Past the reply due date" : "None late") : "Couldn't load",
            href: href("attention", "reply_overdue"),
          },
          { label: "Replies due in 7 days", value: c ? formatCount(c.replyWeek) : "—", sub: c ? "Open or drafted" : "Couldn't load", href: href("attention", "reply_week") },
          { label: "Hearings in 7 days", value: c ? formatCount(c.hearingWeek) : "—", sub: c ? "Including today" : "Couldn't load", href: href("attention", "hearing_week") },
          { label: "Appeals to file", value: c ? formatCount(c.appealOpen) : "—", sub: c ? "Closed against the client" : "Couldn't load", href: href("attention", "appeal_open") },
          { label: "Open notices", value: c ? formatCount(c.open) : "—", sub: c ? "Not closed" : "Couldn't load", href: href("status", "all_open") },
        ]}
      />

      <FilterBar searchLabel="Search notices" searchPlaceholder="Client, notice type, section, reference or DIN" filters={filters} />

      {clientId ? <ClientScopeChip name={fixedClient?.label ?? "This client"} clearHref={tableHref("/workpapers/notices", { filters: { client: null } }, sp)} /> : null}

      {list.ok ? (
        <NoticesTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} emptyAction={newButton} />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the notices." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
