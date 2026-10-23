import type { Metadata } from "next"
import { Suspense } from "react"
import { after } from "next/server"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { can } from "@/lib/auth/roles"
import { getSession } from "@/lib/auth/current-user"
import { env } from "@/lib/env"
import { log, logUnexpected } from "@/lib/log"
import { getSelectedFy } from "@/lib/fy-context"
import { sumPaise, toPaise, paiseToDecimalString } from "@/lib/domain/money"
import { formatMoney } from "@/lib/format"
import { getMessagingContext, type MessagingContext } from "@/lib/data/clients"
import { getClient360, type Client360 } from "@/lib/data/client360"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { ShellTitle, PageGuide } from "@/components/shell/page-slots"
import type { ClientTabProps } from "@/components/client360/types"
import { CLIENT_TABS, resolveTab, type ClientTabId } from "@/components/client360/logic/tabs"
import { ClientHeader } from "@/components/client360/header/client-header"
import { WarningsStrip } from "@/components/client360/warnings-strip"
import { ClientTabNav } from "@/components/client360/tab-nav"
import { TabBoundary } from "@/components/client360/tab-boundary"
import { TabSkeleton } from "@/components/client360/tab-skeletons"
import { OverviewTab } from "@/components/client360/overview/overview-tab"
import { ProfileTab } from "@/components/client360/profile/profile-tab"
import { ServicesTab } from "@/components/client360/services/services-tab"
import { TimelineTab } from "@/components/client360/timeline/timeline-tab"
import ClientTasksTab from "@/components/tasks/client-tasks-tab"
import ClientComplianceTab from "@/components/compliance/client-compliance-tab"
import ClientDocumentsTab from "@/components/documents/client-documents-tab"
import ClientWorkpapersTab from "@/components/workpapers/client-workpapers-tab"
import ClientRegistersTab from "@/components/registers/client-registers-tab"
import ClientBillingTab from "@/components/billing/client-billing-tab"
import ClientEngagementTab from "@/components/practice/client-engagement-tab"
import ClientCommunicationTab from "@/components/comms/client-communication-tab"
import ClientWhatsAppTab from "@/components/whatsapp/client-whatsapp-tab"

type SearchParams = Record<string, string | string[] | undefined>
type Params = { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The browser tab names the client (under the viewer's RLS); anything unexpected falls back to "Client". */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "Client" }
    const s = await getSession()
    if (s.status !== "ok" || s.user.role === "client") return { title: "Client" }
    const { data } = await s.supabase.from("clients").select("display_name").eq("id", id).is("deleted_at", null).maybeSingle()
    return { title: data?.display_name ?? "Client" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "Client" }
  }
}

/** The modules' tabs (§7.3.3), each owned by its module and handed the same ClientTabProps. */
const MODULE_TABS: Partial<Record<ClientTabId, (props: ClientTabProps) => Promise<React.ReactNode> | React.ReactNode>> = {
  tasks: ClientTasksTab,
  compliance: ClientComplianceTab,
  documents: ClientDocumentsTab,
  workpapers: ClientWorkpapersTab,
  registers: ClientRegistersTab,
  billing: ClientBillingTab,
  engagement: ClientEngagementTab,
  communication: ClientCommunicationTab,
  whatsapp: ClientWhatsAppTab,
}

/**
 * Client 360 (§7.3.3): "What's the state of this client: deadlines, open work, money, contact?"
 * The header (facts, identifiers, contact buttons, cover chips, quick actions), the warnings strip,
 * then the tabs in spec order (`?tab=`). Money tabs are Partner/Manager only: hidden for Employees,
 * and never rendered or loaded for them (resolveTab sends them to the Overview). A client the
 * viewer can't see (can_see_client through RLS), or one in the recycle bin, is a 404. Each tab
 * streams in its own Suspense boundary inside an error boundary, so one failing tab never blanks
 * the page.
 */
export default async function ClientPage({ params, searchParams }: Params) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const sp = await searchParams
  const tab = resolveTab(sp.tab, user.role)
  const fy = await getSelectedFy()

  let data: Client360 | null = null
  let messaging: MessagingContext | null = null
  let unpaid: { count: number; outstanding: string } | null = null
  let ref: string | null = null
  try {
    ;[data, messaging] = await Promise.all([getClient360(supabase, user, id, fy), getMessagingContext(supabase, user)])
    if (data && can.deleteClient(user.role)) unpaid = await unpaidInvoices(supabase, id)
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/clients/[id]", userId: user.id, role: user.role, clientId: id })
  }

  if (ref || !messaging) {
    const crumbs = [{ label: user.role === "employee" ? "My clients" : "Clients", href: "/clients" }, { label: "Client" }]
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="Client" className="pb-0 md:pb-0" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this client." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!data) notFound()

  const client = data.client
  const crumbs = [{ label: user.role === "employee" ? "My clients" : "Clients", href: "/clients" }, { label: client.display_name }]
  const portalLink = `${env.appUrl().replace(/\/+$/, "")}/portal`
  const label = CLIENT_TABS.find((t) => t.id === tab)?.label ?? "Overview"
  const tabProps: ClientTabProps = { clientId: client.id, user, supabase, searchParams: sp }
  const Module = MODULE_TABS[tab]

  if (tab === "overview" && user.employeeId) {
    // "client_viewed" in the person's activity feed (§5.2), once per visit to the client's overview.
    const employeeId = user.employeeId
    after(async () => {
      try {
        const { error } = await supabase.from("employee_activities").insert({
          employee_id: employeeId,
          user_id: user.id,
          activity_type: "client_viewed",
          description: `Opened ${client.display_name}`,
          entity_type: "client",
          entity_id: client.id,
          entity_name: client.display_name.slice(0, 200),
        })
        if (error) throw error
      } catch (err) {
        log("warn", "client_viewed activity not written", { source: "page:/clients/[id]", userId: user.id, role: user.role, err })
      }
    })
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title={client.display_name}>
        <p>Everything about this client in one place: open work and deadlines, contacts and team, documents, registers, messages and the timeline.</p>
        {can.seeMoney(user.role) ? <p className="mt-2">Services &amp; fees, Billing and Engagement are visible to Partners and Managers only.</p> : null}
        <p className="mt-2">The warnings under the header say what needs fixing first, with a link to where to do it.</p>
      </PageGuide>

      <ClientHeader data={data} user={user} messaging={messaging} portalLink={portalLink} unpaid={unpaid} />
      <WarningsStrip warnings={data.warnings} />
      <ClientTabNav clientId={client.id} role={user.role} active={tab} />

      <div className="min-w-0">
        {/* Keyed by tab, so a failure in one tab doesn't stay on screen after switching to another. */}
        <TabBoundary key={tab} label={label}>
          <Suspense fallback={<TabSkeleton tab={tab} seesMoney={can.seeMoney(user.role)} searchParams={sp} />}>
            {tab === "overview" ? <OverviewTab data={data} user={user} supabase={supabase} /> : null}
            {tab === "profile" ? <ProfileTab data={data} user={user} supabase={supabase} messaging={messaging} /> : null}
            {tab === "services" && can.seeMoney(user.role) ? <ServicesTab data={data} user={user} supabase={supabase} /> : null}
            {tab === "timeline" ? <TimelineTab clientId={client.id} user={user} supabase={supabase} searchParams={sp} /> : null}
            {Module ? <Module {...tabProps} /> : null}
          </Suspense>
        </TabBoundary>
      </div>
    </div>
  )
}

/** Partner only: unpaid issued invoices, which block Delete (§7.3.4). Summed in paise. */
async function unpaidInvoices(supabase: ClientTabProps["supabase"], clientId: string): Promise<{ count: number; outstanding: string }> {
  const { data, error } = await supabase
    .from("invoices")
    .select("outstanding_amount")
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .is("cancelled_at", null)
    .in("status", ["sent", "partially_paid", "disputed"])
    .gt("outstanding_amount", 0)
    .limit(1000)
  if (error) throw error
  const rows = data ?? []
  return { count: rows.length, outstanding: formatMoney(paiseToDecimalString(sumPaise(rows.map((r) => toPaise(r.outstanding_amount))))) }
}
