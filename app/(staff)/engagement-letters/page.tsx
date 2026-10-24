import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import type { CurrentUser } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { isFinancialYear, todayIST } from "@/lib/domain/fy"
import { SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { statusOptions } from "@/lib/status"
import { GAP_SORTABLE, LETTER_SORTABLE, LetterListFilters, parseLetterView } from "@/lib/schemas/engagement-letters"
import { getLetterSummary, listExpiringLetters, listLetterGaps, listLetters } from "@/lib/data/engagement-letters"
import { getClientLabel } from "@/lib/data/registers"
import { formatCount, parseTableParams, readParam, tableHref } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { ClientScopeChip } from "@/components/registers/register-tabs"
import { LettersTable } from "@/components/engagement-letters/letters-table"
import { GapsTable } from "@/components/engagement-letters/gaps-table"
import { LetterViewTabs } from "@/components/engagement-letters/view-tabs"

export const metadata: Metadata = { title: "Engagement letters" }

type SearchParams = Record<string, string | string[] | undefined>
type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALL_YEARS = "all"

async function attempt<T>(source: string, user: CurrentUser, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/engagement-letters:${source}`, userId: user.id, role: user.role }) }
  }
}

function Failed({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

/**
 * Engagement letters (§7.15.3): "Which clients still need a signed letter this year?" The FY's
 * position leads (no letter, issued and waiting, signed, drafts, expiring in 30 days), then three
 * views: every letter (searched, filtered, sorted and paged in SQL), the clients with active services
 * and no letter Issued or Signed for the FY (each with Draft letter), and letters expiring in 30 days
 * with one-click Renew for next FY. Partners and Managers only (§4.1); RLS refuses anyone else. The
 * jobs link here with ?fy=…&missing=1.
 */
export default async function EngagementLettersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const today = todayIST()
  const view = parseLetterView(sp.view, sp.missing)
  const selected = await getSelectedFy()
  const yearParam = readParam(sp, "year") ?? readParam(sp, "fy")
  const allYears = yearParam === ALL_YEARS && view === "letters"
  const fy = yearParam && isFinancialYear(yearParam) ? yearParam : selected
  const rawClient = readParam(sp, "client")
  const clientId = rawClient && UUID.test(rawClient) ? rawClient : null

  const t = parseTableParams(sp, view === "missing" ? { sortable: GAP_SORTABLE, defaultSort: { sort: "client_name", dir: "asc" } } : { sortable: LETTER_SORTABLE, defaultSort: { sort: view === "expiring" ? "expires_at" : "updated_at", dir: view === "expiring" ? "asc" : "desc" }, filters: LetterListFilters })

  const [summary, client, list] = await Promise.all([
    attempt("summary", user, () => getLetterSummary(supabase, fy, today)),
    clientId ? attempt("client", user, () => getClientLabel(supabase, clientId)) : Promise.resolve(null),
    view === "missing"
      ? attempt("missing", user, async () => ({ kind: "gaps" as const, page: await listLetterGaps(supabase, fy, t) }))
      : view === "expiring"
        ? attempt("expiring", user, async () => ({ kind: "letters" as const, page: await listExpiringLetters(supabase, today, t) }))
        : attempt("letters", user, async () => ({ kind: "letters" as const, page: await listLetters(supabase, t, { fy: allYears ? null : fy, clientId }) })),
  ])
  const s = summary.ok ? summary.data : null
  const clientName = client && client.ok && client.data ? client.data.name : null

  const filters: FilterDef[] =
    view === "letters"
      ? [
          { id: "status", label: "Status", options: statusOptions("engagement_status") },
          { id: "service", label: "Service", options: SERVICE_TYPES.map((x) => ({ value: x, label: SERVICE_TYPE_LABELS[x] })) },
          { id: "kind", label: "Kind", multi: false, options: [{ value: "audit", label: "Audit (SA 210)" }, { value: "non_audit", label: "Other services" }] },
          { id: "year", label: "FY", multi: false, options: [...fyOptions(today).map((y) => ({ value: y, label: `FY ${y}` })), { value: ALL_YEARS, label: "All years" }] },
        ]
      : []

  const newHref = clientId ? `/engagement-letters/new?client=${clientId}&fy=${fy}` : `/engagement-letters/new?fy=${fy}`
  const description = view === "missing" ? `Clients with active services and no letter issued or signed for FY ${fy}.` : view === "expiring" ? "Issued or signed letters that expire in the next 30 days and haven't been renewed." : allYears ? "Every engagement letter, all years." : `Letters for FY ${fy}: what was agreed with each client, and where each letter stands.`

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Engagement letters">
        <p>Every client with active services needs a letter for the FY before the work starts; an audit can&apos;t move past acceptance until its letter is Issued (SA 210).</p>
        <p className="mt-2">A letter is a Draft until it is issued. Once issued, what the client signs is fixed: withdraw it to a draft to change it. Expired is worked out from the expiry date. Renew for next FY copies the scope, services and fees into a new draft to check and issue.</p>
        <p className="mt-2">Fees are fixed and exclude GST. A fee that depends on the result of the work isn&apos;t allowed for a CA in practice.</p>
      </PageGuide>
      <PageHeader
        title="Engagement letters"
        description={description}
        actions={
          <Button asChild>
            <Link href={newHref}>
              <PlusIcon aria-hidden="true" />
              New letter
            </Link>
          </Button>
        }
      />

      <KpiStrip
        lead
        className="mb-4"
        items={[
          { label: `No letter · FY ${fy}`, value: s ? <span className={s.missing ? "text-danger-text" : undefined}>{formatCount(s.missing)}</span> : "—", sub: s ? (s.missing ? "Clients with services, no letter" : "Every client is covered") : "Couldn't load", href: `/engagement-letters?view=missing&year=${fy}` },
          { label: "Issued, not signed", value: s ? formatCount(s.issued) : "—", sub: s ? "With the client" : undefined, href: tableHref("/engagement-letters", { filters: { status: ["issued"], year: [fy] } }) },
          { label: "Signed", value: s ? formatCount(s.signed) : "—", sub: `FY ${fy}`, href: tableHref("/engagement-letters", { filters: { status: ["signed"], year: [fy] } }) },
          { label: "Drafts", value: s ? formatCount(s.drafts) : "—", href: tableHref("/engagement-letters", { filters: { status: ["draft"], year: [fy] } }) },
          { label: "Expiring in 30 days", value: s ? <span className={s.expiring ? "text-warning-text" : undefined}>{formatCount(s.expiring)}</span> : "—", sub: s ? (s.expiring ? "Renew for next FY" : "None") : undefined, href: `/engagement-letters?view=expiring&year=${fy}` },
        ]}
      />

      <LetterViewTabs active={view} fy={fy} counts={{ missing: s?.missing ?? null, expiring: s?.expiring ?? null }} className="mb-4" />

      {clientId && view === "letters" ? <ClientScopeChip name={clientName ?? "This client"} clearHref={tableHref("/engagement-letters", { filters: { client: null } }, sp)} /> : null}

      <FilterBar searchLabel="Search letters" searchPlaceholder={view === "letters" ? "Client, code, scope or notes" : "Client or code"} filters={filters} />

      {!list.ok ? (
        <Failed what={view === "missing" ? "the clients without a letter" : "the engagement letters"} errorRef={list.ref} />
      ) : list.data.kind === "gaps" ? (
        <GapsTable rows={list.data.page.rows} total={list.data.page.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} fy={fy} />
      ) : (
        <LettersTable
          rows={list.data.page.rows}
          total={list.data.page.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          today={today}
          renewColumn={view === "expiring"}
          id={view === "expiring" ? "engagement-letters-expiring" : "engagement-letters"}
          emptyMessage={view === "expiring" ? "No letters expire in the next 30 days." : undefined}
          emptyAction={view === "expiring" ? null : { href: newHref, label: "New letter" }}
        />
      )}
    </div>
  )
}
