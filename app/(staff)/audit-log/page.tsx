import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requirePartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatNumber } from "@/lib/format"
import { AUDIT_EVENTS } from "@/lib/domain/enums"
import { addDays, isDateString, todayIST } from "@/lib/domain/fy"
import { AUDIT_FILTERS, AUDIT_SORTABLE, auditQueryParams, getAuditEntry, getAuditFacets, listAuditLog, type AuditRow } from "@/lib/data/audit-log"
import { parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { PeriodPicker, type PeriodPreset } from "@/components/reports/period-picker"
import { AuditLogTable } from "@/components/audit-log/audit-log-table"
import type { AuditEntryView } from "@/components/audit-log/audit-entry-sheet"
import { AUDIT_EVENT_LABEL, humanise } from "@/components/audit-log/audit-format"

export const metadata: Metadata = { title: "Audit log" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/audit-log:${source}`, userId }) }
  }
}

function toView(r: AuditRow): AuditEntryView {
  return {
    id: r.id,
    at: r.at,
    event: r.event,
    userId: r.user_id,
    userEmail: r.user_email,
    userRole: r.user_role,
    userName: r.user_name,
    ip: r.ip,
    userAgent: r.user_agent,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    action: r.action,
    success: r.success,
    error: r.error,
    details: r.details,
  }
}

/**
 * The audit log (§7.20): "Who did what, and when?" Every audit event: sign-ins, changes with their
 * before/after, exports, password reveals and refusals, filtered by person, event, record and date,
 * with a detail drawer and a CSV export of the filtered set. Partners only (§4.1): a Manager or an
 * Employee is refused here and by the database. Insert-only: nothing on this page can change it.
 */
export default async function AuditLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requirePartner()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: AUDIT_SORTABLE, defaultSort: { sort: "at", dir: "desc" }, filters: AUDIT_FILTERS })
  const today = todayIST()
  const params = auditQueryParams(t, today)
  const entryId = readParam(sp, "entry")

  const [list, facets] = await Promise.all([
    attempt("list", user.id, () => listAuditLog(supabase, params, { offset: t.from, limit: t.pageSize })),
    attempt("facets", user.id, () => getAuditFacets(supabase)),
  ])
  const onPage = list.ok && entryId ? list.data.rows.find((r) => r.id === entryId) : undefined
  const entry = entryId && !onPage ? await attempt("entry", user.id, () => getAuditEntry(supabase, entryId)) : null
  const initialEntry = onPage ? toView(onPage) : entry?.ok && entry.data ? toView(entry.data) : null

  const filters: FilterDef[] = [
    { id: "event", label: "Event", options: AUDIT_EVENTS.map((e) => ({ value: e, label: AUDIT_EVENT_LABEL[e] })), searchable: true },
    ...(facets.ok
      ? [
          {
            id: "user",
            label: "Person",
            multi: false,
            searchable: true,
            options: [...facets.data.users, ...(facets.data.hasSystem ? [{ value: "system", label: "The system (jobs, webhooks, public pages)" }] : [])],
          },
          { id: "resource", label: "Record", multi: false, searchable: facets.data.resourceTypes.length > 7, options: facets.data.resourceTypes.map((r) => ({ value: r, label: humanise(r) })) },
        ]
      : []),
    { id: "outcome", label: "Outcome", multi: false, options: [{ value: "success", label: "Succeeded" }, { value: "failure", label: "Failed or refused" }] },
  ]

  const chosenFrom = readParam(sp, "from")
  const chosenTo = readParam(sp, "to")
  const isDefault = !(isDateString(chosenFrom) && isDateString(chosenTo))
  const monthStart = `${today.slice(0, 8)}01`
  const lastMonthEnd = addDays(monthStart, -1)
  const presets: PeriodPreset[] = [
    { id: "today", label: "Today", from: today, to: today },
    { id: "7", label: "Last 7 days", from: addDays(today, -6), to: today },
    { id: "30", label: "Last 30 days", from: addDays(today, -29), to: today },
    { id: "90", label: "Last 90 days", from: addDays(today, -89), to: today },
    { id: "month", label: "This month", from: monthStart, to: today },
    { id: "last-month", label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
  ]

  const exportParams = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined || k === "page" || k === "size" || k === "entry") continue
    for (const one of Array.isArray(v) ? v : [v]) exportParams.append(k, one)
  }
  const exportHref = `/api/exports/audit-log${exportParams.toString() ? `?${exportParams.toString()}` : ""}`

  const description = list.ok
    ? `${formatNumber(list.data.total)} ${list.data.total === 1 ? "entry" : "entries"}${isDefault ? " since records began" : ""}, insert-only`
    : "Every sign-in, change, export and password reveal, insert-only."

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Audit log">
        <p>Every change anyone makes is recorded here with who, when, from where and, for changes, the values before and after. So are sign-ins and failed sign-ins, exports, file downloads, portal password reveals and anything the system refused.</p>
        <p className="mt-2">Nobody can edit or delete an entry, Partners included. Times are in IST. Open an entry for its details; its address can be shared with another Partner.</p>
        <p className="mt-2">Export CSV downloads every entry the filters match, oldest first. The export itself is recorded here too.</p>
      </PageGuide>
      <PageHeader title="Audit log" description={description} />
      <FilterBar
        searchLabel="Search the audit log"
        searchPlaceholder="Action, record id or email"
        filters={filters}
        actions={<PeriodPicker from={isDefault ? addDays(today, -29) : (chosenFrom as string)} to={isDefault ? today : (chosenTo as string)} presets={presets} isDefault={isDefault} defaultLabel="All time" max={today} label="When" />}
      />
      {!facets.ok ? (
        <p className="mb-3 text-sm text-text-muted">
          The person and record filters couldn&apos;t load (Ref <span className="font-mono">{facets.ref}</span>). The log itself is below.
        </p>
      ) : null}
      {entryId && entry && (!entry.ok || !entry.data) ? (
        <p role="status" className="mb-3 text-sm text-text-muted">
          {entry.ok ? "That entry isn't in the audit log." : <>Couldn&apos;t open that entry (Ref <span className="font-mono">{entry.ref}</span>).</>}
        </p>
      ) : null}
      {list.ok ? (
        <AuditLogTable
          rows={list.data.rows.map(toView)}
          total={list.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          exportHref={exportHref}
          initialEntry={initialEntry}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the audit log." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
