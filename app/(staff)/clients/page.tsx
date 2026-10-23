import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { ENTITY_TYPE_LABELS, ENTITY_TYPES, GST_SCHEME_LABELS, GST_SCHEMES, SERVICE_TYPE_LABELS, SERVICE_TYPES } from "@/lib/domain/enums"
import { statusOptions } from "@/lib/status"
import { formatCount, parseTableParams } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar, type FilterDef } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import {
  CLIENT_LIST_FILTERS,
  CLIENT_LIST_SORTABLE,
  FLAG_LABELS,
  GST_FILTER_LABELS,
  GST_FILTER_VALUES,
  ONBOARDED_FILTER_LABELS,
  ONBOARDED_FILTER_VALUES,
  WHATSAPP_FILTER_VALUES,
  WHATSAPP_GROUP_LABELS,
  flagOptionsFor,
} from "@/lib/schemas/clients"
import {
  getClientListSummary,
  getMessagingContext,
  getPrimaryContacts,
  listClientViews,
  listClients,
  listGroupOptions,
  listStaffOptions,
} from "@/lib/data/clients"
import { getMyCoveredClients } from "@/lib/data/covers"
import { coverBadge } from "@/lib/domain/cover"
import { firstNameOf } from "@/lib/domain/messaging"
import { ClientsTable } from "@/components/clients/clients-table"
import { ClientsViews } from "@/components/clients/clients-views"
import { ClientExportMenu } from "@/components/clients/export-menu"
import { ImportClientsDialog } from "@/components/clients/import-clients-dialog"
import { UnreachableBanner } from "@/components/clients/unreachable-banner"

export const metadata: Metadata = { title: "Clients" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/clients:${source}`, userId }) }
  }
}

/**
 * Clients (§7.3.1): every client the person may see (Partners and Managers: all; Employees: the ones
 * they own, are on the team of, or cover, §4.1), searched, filtered, sorted and paged in SQL (§2.3).
 * Outstanding amounts are Partner/Manager only. "N clients can't be reached" opens that filter.
 */
export default async function ClientsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const seesMoney = can.seeMoney(user.role)
  const canManage = can.editClients(user.role)
  const canDelete = can.deleteClient(user.role)
  const sp = await searchParams
  const t = parseTableParams(sp, {
    sortable: CLIENT_LIST_SORTABLE,
    defaultSort: { sort: "display_name", dir: "asc" },
    filters: CLIENT_LIST_FILTERS,
  })
  const today = todayIST()
  const covering = Boolean(t.filters.covering)

  // The clients this person covers for a colleague (§4.7): their badges, and `?covering=1`.
  const covered = user.employeeId ? await attempt("covers", user.id, () => getMyCoveredClients(supabase, user.employeeId!)) : null
  const coveredIds = covered && covered.ok ? [...covered.data.keys()] : []

  const [list, summary, staff, groups, views, messaging] = await Promise.all([
    covering && covered && !covered.ok
      ? Promise.resolve(covered)
      : attempt("list", user.id, () => listClients(supabase, t, { seesMoney, ids: covering ? coveredIds : undefined })),
    attempt("summary", user.id, () => getClientListSummary(supabase)),
    attempt("staff", user.id, () => listStaffOptions(supabase, user.role)),
    attempt("groups", user.id, () => listGroupOptions(supabase)),
    attempt("views", user.id, () => listClientViews(supabase, user.id)),
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
  ])
  const contacts = list.ok ? await attempt("contacts", user.id, () => getPrimaryContacts(supabase, list.data.rows.map((r) => r.id))) : null

  const staffOptions = staff.ok ? staff.data.map((s) => ({ value: s.id, label: s.name, description: s.designation ?? undefined })) : []
  const groupOptions = groups.ok ? groups.data.map((g) => ({ value: g.id, label: g.name })) : []

  const filters: FilterDef[] = [
    { id: "status", label: "Status", options: statusOptions("client_status") },
    { id: "priority", label: "Priority", options: statusOptions("client_priority") },
    { id: "owner", label: "Owner", options: [{ value: "none", label: "Unassigned" }, ...staffOptions.map((s) => ({ value: s.value, label: s.label }))], searchable: true },
    { id: "service", label: "Service", options: SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] })) },
    { id: "entity", label: "Entity", options: ENTITY_TYPES.map((e) => ({ value: e, label: ENTITY_TYPE_LABELS[e] })) },
    { id: "gst", label: "GST", options: GST_FILTER_VALUES.map((g) => ({ value: g, label: GST_FILTER_LABELS[g] })) },
    { id: "scheme", label: "Scheme", options: GST_SCHEMES.map((s) => ({ value: s, label: GST_SCHEME_LABELS[s] })) },
    ...(groupOptions.length ? [{ id: "group", label: "Group", options: [{ value: "none", label: "No group" }, ...groupOptions], searchable: true }] : []),
    { id: "onboarded", label: "Onboarded", options: ONBOARDED_FILTER_VALUES.map((v) => ({ value: v, label: ONBOARDED_FILTER_LABELS[v] })), multi: false },
    { id: "whatsapp", label: "WhatsApp group", options: WHATSAPP_FILTER_VALUES.map((v) => ({ value: v, label: WHATSAPP_GROUP_LABELS[v] })) },
    { id: "flag", label: "Flags", options: flagOptionsFor(seesMoney).map((f) => ({ value: f, label: FLAG_LABELS[f] })) },
    ...(coveredIds.length || covering ? [{ id: "covering", label: "Covering", options: [{ value: "1", label: "Clients I'm covering" }], multi: false }] : []),
  ]

  const description = summary.ok
    ? canManage
      ? [
          `${formatCount(summary.data.total)} ${summary.data.total === 1 ? "client" : "clients"}`,
          summary.data.pending ? `${formatCount(summary.data.pending)} waiting to finish onboarding` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : `${formatCount(summary.data.total)} ${summary.data.total === 1 ? "client" : "clients"} you own, are on the team of, or are covering`
    : canManage
      ? "Every client with status, owner, services and the next deadline."
      : "The clients you own, are on the team of, or are covering."

  const badges = covered && covered.ok ? covered.data : null
  const rows = list.ok
    ? list.data.rows.map((r) => {
        const cover = badges?.get(r.id)
        return {
          ...r,
          contact: contacts && contacts.ok ? (contacts.data.get(r.id) ?? null) : null,
          cover_badge: cover ? coverBadge(firstNameOf(cover.absentName) || cover.absentName, cover.endsAt) : null,
        }
      })
    : []
  const appUrl = env.appUrl().replace(/\/+$/, "")
  const flagActive = (t.filters.flag ?? []).includes("unreachable")

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title={canManage ? "Clients" : "My clients"}>
        <p>Search by name, code, PAN, GSTIN, email or phone, and narrow the list with the filters. Each filter and the sort are kept in the address, so a view can be saved or shared.</p>
        <p className="mt-2">
          {canManage
            ? "Select clients to assign an owner, add them to a group, change their status or export them. Changing the status to On hold or Inactive pauses reminders to the client and automatic invoicing."
            : "You see the clients you own, are on the team of, or are covering while a colleague is away. Fees and invoices are not shown here."}
        </p>
        <p className="mt-2">The WhatsApp and email buttons open WhatsApp or Gmail with a draft; you press Send there, and the app records it as handed off.</p>
      </PageGuide>
      <PageHeader
        title={canManage ? "Clients" : "My clients"}
        description={description}
        actions={
          canManage ? (
            <>
              <ImportClientsDialog />
              <Button asChild>
                <Link href="/clients/new">
                  <PlusIcon aria-hidden="true" />
                  New client
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      {summary.ok ? <UnreachableBanner count={summary.data.unreachable} active={flagActive} /> : null}
      <FilterBar
        searchLabel="Search clients"
        searchPlaceholder="Name, code, PAN, GSTIN, email or phone"
        filters={filters}
        savedViews={views.ok ? <ClientsViews views={views.data} canShare={canManage} /> : null}
        exportSlot={<ClientExportMenu />}
      />
      {list.ok ? (
        <ClientsTable
          rows={rows}
          total={list.data.total}
          page={t.page}
          pageSize={t.pageSize}
          sort={t.sort}
          dir={t.dir}
          today={today}
          seesMoney={seesMoney}
          canManage={canManage}
          canDelete={canDelete}
          staff={staffOptions}
          groups={groupOptions}
          messaging={{
            firmName: messaging.ok ? messaging.data.firmName : "TaxWise Consultants",
            firmPhone: messaging.ok ? messaging.data.firmPhone : null,
            countryCode: messaging.ok ? messaging.data.countryCode : "91",
            signatureFormat: messaging.ok ? messaging.data.signatureFormat : "– {first_name}",
            addSignature: messaging.ok ? messaging.data.addSignature : user.role !== "partner",
            senderName: user.fullName,
            templates: messaging.ok ? messaging.data.templates : [],
            portalUrl: `${appUrl}/portal`,
          }}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the clients." errorRef={list.ref} />
        </div>
      )}
    </div>
  )
}
