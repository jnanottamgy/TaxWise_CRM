import { unstable_rethrow } from "next/navigation"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { can } from "@/lib/auth/roles"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { SERVICE_FREQUENCY_LABELS, SERVICE_TYPES } from "@/lib/domain/enums"
import { todayIST } from "@/lib/domain/fy"
import { sacFor } from "@/lib/domain/gst"
import { serviceName } from "@/lib/schemas/client-services"
import { getServices, type Client360, type ServicesData } from "@/lib/data/client360"
import { nextInvoicePreview } from "@/components/client360/logic/next-invoice"
import { ServicesPanel, type ServiceView } from "@/components/client360/services/services-panel"

/**
 * Client 360 → Services & fees (§7.3.3 tab 3), Partner/Manager only. The page never renders this
 * tab for an Employee; the role check here and RLS on client_services (0033) refuse it anyway.
 */
export async function ServicesTab({ data, user, supabase }: { data: Client360; user: CurrentUser; supabase: ServerSupabase }) {
  if (!can.seeMoney(user.role)) return null
  const { client } = data
  let s: ServicesData
  try {
    s = await getServices(supabase, client.id)
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "client360:services", userId: user.id, role: user.role, clientId: client.id })
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load this client's services and fees." errorRef={ref} />
      </div>
    )
  }

  const today = todayIST()
  const individual = client.entity_type === "individual"
  const sacOf = (type: (typeof SERVICE_TYPES)[number]) => sacFor(type, s.firm.sac_by_service ?? undefined, null, { individual, defaultSac: s.firm.default_sac }).sac
  const defaultSacFor: Record<string, string> = { default: s.firm.default_sac }
  for (const t of SERVICE_TYPES) defaultSacFor[t] = sacOf(t)

  const views: ServiceView[] = s.services.map((row) => ({
    row,
    // The calendar's next deadline for this service; a hand-set date only where the calendar has none.
    nextDue: (row.is_active ? s.nextDue[row.service_type] : null) ?? (row.next_due_date ? { date: row.next_due_date, title: null } : null),
    defaultSac: sacOf(row.service_type),
    preview: nextInvoicePreview({
      service: row,
      client: { gstin: client.gstin, state_code: client.state_code, entity_type: client.entity_type, status: client.status },
      firm: s.firm,
      today,
    }),
  }))
  const nameOf = new Map(s.services.map((r) => [r.id, serviceName(r.service_type, r.custom_name)]))

  return (
    <div className="flex flex-col gap-4">
      <ServicesPanel clientId={client.id} clientName={client.display_name} views={views} defaultSacFor={defaultSacFor} />
      <SectionCard title="Fee history" description="Every agreed fee and billing cycle, newest first" flush>
        {s.history.length === 0 ? (
          <div className="px-4 pb-4 md:px-5">
            <EmptyState size="compact" message="No fees agreed yet." />
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[36rem] text-base">
              <thead>
                <tr className="h-9 bg-surface-2 text-left text-xs font-medium text-text-muted">
                  <th scope="col" className="sticky left-0 bg-surface-2 px-4 font-medium md:px-5">
                    Agreed on
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Service
                  </th>
                  <th scope="col" className="px-3 text-right font-medium">
                    Fee
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Billed
                  </th>
                  <th scope="col" className="px-4 font-medium md:px-5">
                    By
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.history.map((h) => (
                  <tr key={h.id} className="h-(--row-height) border-t border-border/70">
                    <td className="sticky left-0 bg-surface px-4 md:px-5">
                      <DateText date={h.changed_at} />
                    </td>
                    <td className="px-3">{nameOf.get(h.client_service_id) ?? "A removed service"}</td>
                    <td className="px-3 text-right">{h.agreed_fee !== null ? <Money value={h.agreed_fee} /> : <span className="text-text-muted">Not agreed</span>}</td>
                    <td className="px-3 text-text-muted">{h.billing_frequency ? SERVICE_FREQUENCY_LABELS[h.billing_frequency] : "As filed"}</td>
                    <td className="px-4 text-text-muted md:px-5">{h.changed_by_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}
