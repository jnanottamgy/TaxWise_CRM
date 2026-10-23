import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { readParam } from "@/components/app/data-table/params"
import { getBuilderSettings, prefillFromClient, prefillFromLead, type BuilderPrefill, type BuilderSettings } from "@/lib/data/quotations"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { QuotationBuilder } from "@/components/quotations/builder/quotation-builder"
import { newBuilderValues } from "@/components/quotations/builder/builder-initial"

export const metadata: Metadata = { title: "New quotation" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * New quotation (§7.5.2), Partners and Managers only (§4.1). `?lead=<id>` starts it for a lead (the
 * lead's "Create quotation"), `?client=<id>` for an existing client (Client 360 "New quotation"),
 * pre-filling who it's for. The Draft is saved on the server as soon as the name, email and dates
 * are in (§3.4); its number comes from the quotation series then.
 */
export default async function NewQuotationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const leadParam = readParam(sp, "lead")
  const clientParam = readParam(sp, "client")
  const crumbs = [{ label: "Quotations", href: "/quotations" }, { label: "New quotation" }]

  const leadId = leadParam && UUID.test(leadParam) ? leadParam : null
  const clientId = !leadId && clientParam && UUID.test(clientParam) ? clientParam : null
  let loaded: { settings: BuilderSettings; prefill: BuilderPrefill | null } | null = null
  let errorRef: string | null = null
  try {
    const [settings, prefill] = await Promise.all([
      getBuilderSettings(supabase),
      leadId ? prefillFromLead(supabase, leadId) : clientId ? prefillFromClient(supabase, clientId) : Promise.resolve<BuilderPrefill | null>(null),
    ])
    loaded = { settings, prefill }
  } catch (err) {
    unstable_rethrow(err)
    errorRef = logUnexpected(err, { source: "page:/quotations/new", userId: user.id })
  }

  if (!loaded) {
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="New quotation" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't open the quotation builder." errorRef={errorRef ?? undefined} />
        </div>
      </div>
    )
  }

  const { settings, prefill } = loaded
  const missing = (leadParam || clientParam) && !prefill ? (leadParam ? "That lead" : "That client") : null
  const storageKey = `quotation:new${prefill?.lead_id ? `:lead:${prefill.lead_id}` : prefill?.client_id ? `:client:${prefill.client_id}` : ""}`

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="New quotation">
        <p>Choose a lead or an existing client to fill in who it&apos;s for, or type the details for someone else. A valid GSTIN sets the place of supply, which decides CGST + SGST or IGST.</p>
        <p className="mt-2">Add a line per service with its frequency, quantity, unit price and GST rate. Fees are fixed: a fee that depends on the result of the work isn&apos;t allowed for a CA in practice.</p>
        <p className="mt-2">The draft saves itself every few seconds. Review &amp; send opens the quotation, where you send it or submit it for a Partner&apos;s approval.</p>
      </PageGuide>
      <PageHeader breadcrumbs={crumbs} title="New quotation" description={prefill?.label ? `For ${prefill.label}` : "It gets its number when the draft is first saved."} />
      {missing ? (
        <p role="note" className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-base text-text">
          {missing} couldn&apos;t be found (it may have been deleted), so the quotation starts blank.
        </p>
      ) : null}
      <QuotationBuilder
        initial={newBuilderValues(settings, prefill)}
        partyLabel={prefill?.label ?? null}
        context={{ today: settings.today, validityDays: settings.validityDays, firmStateCode: settings.firmStateCode, approvalLimitPaise: settings.approvalLimitPaise }}
        authorRole={user.role === "partner" ? "partner" : "manager"}
        quotation={null}
        storageKey={storageKey}
      />
    </div>
  )
}
