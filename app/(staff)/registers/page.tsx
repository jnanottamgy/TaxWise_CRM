import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { isManagerOrPartner, isPartner } from "@/lib/auth/roles"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { financialYearOf, todayIST, type DateString } from "@/lib/domain/fy"
import { fyOptions } from "@/lib/fy-context"
import {
  CREDENTIAL_SORTABLE,
  CredentialListFilters,
  DSC_SORTABLE,
  DscListFilters,
  FILING_ORIGIN_LABEL,
  FILING_SORTABLE,
  FilingListFilters,
  PORTALS,
  PORTAL_LABEL,
  REGISTRATION_SORTABLE,
  REGISTRATION_TYPES,
  REGISTRATION_TYPE_LABEL,
  REPORT_FORM_OPTIONS,
  RegistrationListFilters,
  UDIN_SORTABLE,
  UdinListFilters,
  parseRegisterTab,
  registersHref,
  type RegisterTab,
} from "@/lib/schemas/registers"
import {
  getCeilingPanel,
  getClientLabel,
  getDscSummary,
  getFilingFacets,
  getRegistrationSummary,
  listCredentials,
  listDscs,
  listFilings,
  listRegistrations,
  listReportsWithoutUdin,
  listSigningMembers,
  listUdins,
} from "@/lib/data/registers"
import { formatCount, parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { KpiStrip } from "@/components/app/kpi-strip"
import { statusOptions } from "@/lib/status"
import { PageGuide } from "@/components/shell/page-slots"
import { ClientScopeChip, RegisterTabs } from "@/components/registers/register-tabs"
import { AddCredentialButton, CredentialsTable } from "@/components/registers/credentials-table"
import { RegistrationsTable } from "@/components/registers/registrations-table"
import { AddRegistrationButton } from "@/components/registers/registration-dialog"
import { DscTable } from "@/components/registers/dsc-table"
import { AddDscButton } from "@/components/registers/dsc-dialog"
import { UdinTable } from "@/components/registers/udin-table"
import { LogUdinButton } from "@/components/registers/udin-dialog"
import { CeilingPanel, MissingUdinList } from "@/components/registers/ceiling-panel"
import { FilingsTable } from "@/components/registers/filings-table"
import { ImportFilingsDialog } from "@/components/registers/import-filings-dialog"

export const metadata: Metadata = { title: "Registers" }

type SearchParams = Record<string, string | string[] | undefined>
type Loaded<T> = { ok: true; data: T } | { ok: false; ref: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function attempt<T>(source: string, user: CurrentUser, load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/registers:${source}`, userId: user.id, role: user.role }) }
  }
}

function Failed({ what, errorRef }: { what: string; errorRef: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={`Couldn't load ${what}.`} errorRef={errorRef} />
    </div>
  )
}

const DESCRIPTION: Record<RegisterTab, string> = {
  vault: "Clients' government portal logins. Passwords are encrypted, never listed, and shown on Reveal for 30 seconds; every reveal is logged.",
  registrations: "Statutory registrations with their expiry reminders, and each DIN's DIR-3 KYC Web cycle.",
  dsc: "Digital signature certificates: who holds each token and when it expires. Alerts go at 30, 15 and 7 days.",
  udin: "Every UDIN against its client, filing and signing partner, with each partner's tax audits against the ICAI ceiling.",
  filings: "What was filed for each client, by us or inherited from a previous CA.",
}

/**
 * Registers (§7.15.1, §7.15.2): one page per register (`?tab=vault|registrations|dsc|udin|filings`;
 * the dashboards link to tab=udin, dsc and registrations), each searched, filtered, sorted and paged
 * in SQL, and narrowed to one client with `?client=` (Client 360 and the expiry notices link there).
 * Partners and Managers see every client and keep the registers; an Employee sees their own clients'
 * rows (covered clients too), reads them, logs a UDIN they signed themselves, and reveals a stored
 * password only with Vault access (§4.1). RLS decides every row; the screen only hides what a role
 * can't use.
 */
export default async function RegistersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const tab = parseRegisterTab(sp.tab)
  const today = todayIST()
  const canManage = isManagerOrPartner(user.role)
  const rawClient = readParam(sp, "client")
  const clientId = rawClient && UUID.test(rawClient) ? rawClient : null
  const client = clientId ? await attempt("client", user, () => getClientLabel(supabase, clientId)) : null
  const clientName = client && client.ok && client.data ? client.data.name : null
  const scope = clientId ? { id: clientId, name: clientName ?? "This client" } : null

  const section =
    tab === "vault" ? (
      <VaultSection user={user} supabase={supabase} sp={sp} clientId={clientId} canManage={canManage} />
    ) : tab === "registrations" ? (
      <RegistrationsSection user={user} supabase={supabase} sp={sp} clientId={clientId} canManage={canManage} today={today} />
    ) : tab === "dsc" ? (
      <DscSection user={user} supabase={supabase} sp={sp} clientId={clientId} canManage={canManage} today={today} />
    ) : tab === "udin" ? (
      <UdinSection user={user} supabase={supabase} sp={sp} clientId={clientId} scope={scope} canManage={canManage} today={today} />
    ) : (
      <FilingsSection user={user} supabase={supabase} sp={sp} clientId={clientId} scope={scope} canManage={canManage} />
    )

  const actions =
    tab === "vault" && canManage ? (
      <AddCredentialButton fixedClient={scope} />
    ) : tab === "registrations" && canManage ? (
      <AddRegistrationButton fixedClient={scope} />
    ) : tab === "dsc" && canManage ? (
      <AddDscButton fixedClient={scope} />
    ) : tab === "filings" && canManage ? (
      <ImportFilingsDialog fixedClient={scope} variant="default" />
    ) : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Registers">
        <p>Each tab is one register. Narrow any of them to a client from that client&apos;s Registers tab, or with the client chip.</p>
        <p className="mt-2">Passwords in the vault are sealed with AES-256-GCM when stored and opened only on Reveal: Partners and Managers for any client; Employees with Vault access for their own clients, and for a covered client only when the cover includes portal passwords. Each reveal is recorded with the person, time and IP.</p>
        <p className="mt-2">The tax-audit ceiling counts each partner&apos;s Form 3CA and 3CB (a), (b) and combined reports by the date they were signed, once for head office and branch reports of the same year, never for revised reports, plus audits signed elsewhere. A 61st needs a Partner&apos;s confirmation.</p>
      </PageGuide>
      <PageHeader title="Registers" description={DESCRIPTION[tab]} actions={tab === "udin" ? <UdinAction user={user} supabase={supabase} scope={scope} /> : actions} />
      <RegisterTabs active={tab} clientId={clientId} className="mb-4" />
      {scope ? <ClientScopeChip name={scope.name} clearHref={registersHref(tab)} /> : null}
      {section}
    </div>
  )
}

type SectionProps = { user: CurrentUser; supabase: ServerSupabase; sp: SearchParams; clientId: string | null; canManage: boolean }

async function VaultSection({ user, supabase, sp, clientId, canManage }: SectionProps) {
  const t = parseTableParams(sp, { sortable: CREDENTIAL_SORTABLE, defaultSort: { sort: "client_name", dir: "asc" }, filters: CredentialListFilters })
  const list = await attempt("vault", user, () => listCredentials(supabase, t, { clientId }))
  const filters: FilterDef[] = [
    { id: "portal", label: "Portal", options: PORTALS.map((p) => ({ value: p, label: PORTAL_LABEL[p] })) },
    { id: "reveal", label: "You can reveal", multi: false, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
  ]
  return (
    <>
      <FilterBar searchLabel="Search stored logins" searchPlaceholder="Client, code, username or notes" filters={filters} />
      {list.ok ? (
        <CredentialsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} canManage={canManage} />
      ) : (
        <Failed what="the stored logins" errorRef={list.ref} />
      )}
    </>
  )
}

async function RegistrationsSection({ user, supabase, sp, clientId, canManage, today }: SectionProps & { today: DateString }) {
  const t = parseTableParams(sp, { sortable: REGISTRATION_SORTABLE, defaultSort: { sort: "client_name", dir: "asc" }, filters: RegistrationListFilters })
  const [list, summary] = await Promise.all([
    attempt("registrations", user, () => listRegistrations(supabase, t, { today, clientId })),
    clientId ? Promise.resolve(null) : attempt("registrations:summary", user, () => getRegistrationSummary(supabase, today)),
  ])
  const filters: FilterDef[] = [
    { id: "type", label: "Type", options: REGISTRATION_TYPES.map((r) => ({ value: r, label: REGISTRATION_TYPE_LABEL[r] })) },
    { id: "status", label: "Status", options: statusOptions("registration_status") },
    { id: "expiring", label: "Expiring", multi: false, options: [{ value: "30", label: "In 30 days" }, { value: "90", label: "In 90 days" }] },
  ]
  const s = summary && summary.ok ? summary.data : null
  return (
    <>
      {s ? (
        <KpiStrip
          className="mb-4"
          items={[
            { label: "Active", value: formatCount(s.active), sub: "In force today", href: registersHref("registrations", { status: "active" }) },
            { label: "Expiring in 30 days", value: <span className={s.expiring ? "text-warning-text" : undefined}>{formatCount(s.expiring)}</span>, sub: s.expiring ? "Renewal to arrange" : "Nothing coming up", href: registersHref("registrations", { expiring: "30" }) },
            { label: "Past expiry", value: <span className={s.pastExpiry ? "text-danger-text" : undefined}>{formatCount(s.pastExpiry)}</span>, sub: s.pastExpiry ? "Renew, or mark surrendered" : "None", href: registersHref("registrations", { status: "expired" }) },
            { label: `DIR-3 KYC due · FY ${s.fy}`, value: formatCount(s.kycDue), sub: "DINs due this FY or earlier", href: registersHref("registrations", { type: "DIN" }) },
          ]}
        />
      ) : null}
      <FilterBar searchLabel="Search registrations" searchPlaceholder="Client, code, number or jurisdiction" filters={filters} />
      {list.ok ? (
        <RegistrationsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} canManage={canManage} />
      ) : (
        <Failed what="the registrations" errorRef={list.ref} />
      )}
    </>
  )
}

async function DscSection({ user, supabase, sp, clientId, canManage, today }: SectionProps & { today: DateString }) {
  const t = parseTableParams(sp, { sortable: DSC_SORTABLE, defaultSort: { sort: "expiry_date", dir: "asc" }, filters: DscListFilters })
  const [list, summary] = await Promise.all([
    attempt("dsc", user, () => listDscs(supabase, t, { today, clientId })),
    clientId ? Promise.resolve(null) : attempt("dsc:summary", user, () => getDscSummary(supabase, today)),
  ])
  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: statusOptions("dsc_status") },
    { id: "expiring", label: "Expiring", multi: false, options: [{ value: "month", label: "This month" }, { value: "30", label: "In 30 days" }, { value: "90", label: "In 90 days" }] },
    { id: "custody", label: "Custody", multi: false, options: [{ value: "firm", label: "With the firm" }, { value: "client", label: "With the client" }, { value: "person", label: "With a named person" }] },
  ]
  const s = summary && summary.ok ? summary.data : null
  return (
    <>
      {s ? (
        <KpiStrip
          className="mb-4"
          lead
          items={[
            { label: "Expiring this month", value: <span className={s.thisMonth ? "text-warning-text" : undefined}>{formatCount(s.thisMonth)}</span>, sub: s.thisMonth ? "Renew before the next filing" : "None this month", href: registersHref("dsc", { expiring: "month" }) },
            { label: "In the next 30 days", value: formatCount(s.next30), href: registersHref("dsc", { expiring: "30" }) },
            { label: "Active", value: formatCount(s.active), href: registersHref("dsc", { status: "active" }) },
            { label: "Expired", value: <span className={s.expired ? "text-danger-text" : undefined}>{formatCount(s.expired)}</span>, sub: s.expired ? "Renew, or mark revoked" : "None", href: registersHref("dsc", { status: "expired" }) },
          ]}
        />
      ) : null}
      <FilterBar searchLabel="Search DSCs" searchPlaceholder="Client, holder, serial or custody" filters={filters} />
      {list.ok ? (
        <DscTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} canManage={canManage} />
      ) : (
        <Failed what="the DSC register" errorRef={list.ref} />
      )}
    </>
  )
}

async function UdinAction({ user, supabase, scope }: { user: CurrentUser; supabase: ServerSupabase; scope: { id: string; name: string } | null }) {
  const members = await attempt("udin:members", user, () => listSigningMembers(supabase, user))
  if (!members.ok || members.data.length === 0) return null
  return <LogUdinButton members={members.data} isPartner={isPartner(user.role)} fixedClient={scope} />
}

async function UdinSection({ user, supabase, sp, clientId, scope, canManage, today }: SectionProps & { scope: { id: string; name: string } | null; today: DateString }) {
  const t = parseTableParams(sp, { sortable: UDIN_SORTABLE, defaultSort: { sort: "signed_on", dir: "desc" }, filters: UdinListFilters })
  const fy = t.filters.year?.[0] ?? financialYearOf(today)
  const [list, members, ceiling, missing] = await Promise.all([
    attempt("udin", user, () => listUdins(supabase, t, { clientId })),
    attempt("udin:members", user, () => listSigningMembers(supabase, user)),
    canManage && !clientId ? attempt("udin:ceiling", user, () => getCeilingPanel(supabase, fy)) : Promise.resolve(null),
    canManage ? attempt("udin:missing", user, () => listReportsWithoutUdin(supabase, today, 8)) : Promise.resolve(null),
  ])
  const memberList = members.ok ? members.data : []
  const filters: FilterDef[] = [
    ...(canManage && memberList.length > 1 ? [{ id: "partner", label: "Signing partner", options: memberList.map((m) => ({ value: m.id, label: m.name })) }] : []),
    { id: "form", label: "Report form", options: REPORT_FORM_OPTIONS },
    { id: "counted", label: "Ceiling", multi: false, options: [{ value: "yes", label: "Counts" }, { value: "no", label: "Doesn't count" }] },
    { id: "late", label: "Generated late", multi: false, options: [{ value: "yes", label: "After 60 days" }] },
    { id: "year", label: "FY signed", multi: false, options: fyOptions(today).map((y) => ({ value: y, label: `FY ${y}` })) },
  ]
  const missingRows = missing && missing.ok ? (clientId ? missing.data.rows.filter((r) => r.client_id === clientId) : missing.data.rows) : []
  return (
    <>
      {canManage && (ceiling || missing) ? (
        <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {ceiling ? ceiling.ok ? <CeilingPanel data={ceiling.data} canEdit={isPartner(user.role)} /> : <Failed what="the tax-audit ceiling" errorRef={ceiling.ref} /> : null}
          {missing ? missing.ok ? <MissingUdinList rows={missingRows} total={clientId ? missingRows.length : missing.data.total} members={memberList} isPartner={isPartner(user.role)} /> : <Failed what="the signed reports without a UDIN" errorRef={missing.ref} /> : null}
        </div>
      ) : null}
      <FilterBar searchLabel="Search UDINs" searchPlaceholder="UDIN, client, code, document or remarks" filters={filters} />
      {list.ok ? (
        <UdinTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} canManage={canManage} isPartner={isPartner(user.role)} members={memberList} fixedClient={scope} />
      ) : (
        <Failed what="the UDIN register" errorRef={list.ref} />
      )}
    </>
  )
}

async function FilingsSection({ user, supabase, sp, clientId, scope, canManage }: SectionProps & { scope: { id: string; name: string } | null }) {
  const t = parseTableParams(sp, { sortable: FILING_SORTABLE, defaultSort: { sort: "filed_on", dir: "desc" }, filters: FilingListFilters })
  const [list, facets] = await Promise.all([attempt("filings", user, () => listFilings(supabase, t, { clientId })), attempt("filings:facets", user, () => getFilingFacets(supabase, clientId))])
  const f = facets.ok ? facets.data : { forms: [], years: [] }
  const filters: FilterDef[] = [
    { id: "origin", label: "Filed by", multi: false, options: [{ value: "ours", label: FILING_ORIGIN_LABEL.ours }, { value: "inherited", label: FILING_ORIGIN_LABEL.inherited }] },
    ...(f.years.length ? [{ id: "year", label: "FY", options: f.years.map((y) => ({ value: y, label: `FY ${y}` })) }] : []),
    ...(f.forms.length ? [{ id: "form", label: "Form", options: f.forms.map((x) => ({ value: x, label: x })), searchable: f.forms.length > 7 }] : []),
  ]
  return (
    <>
      <FilterBar searchLabel="Search filings" searchPlaceholder="Client, form, period, acknowledgement or previous firm" filters={filters} />
      {list.ok ? (
        <FilingsTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} canManage={canManage} fixedClient={scope} />
      ) : (
        <Failed what="the filing history" errorRef={list.ref} />
      )}
    </>
  )
}

