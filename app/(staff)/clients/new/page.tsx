import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { CircleSlashIcon } from "lucide-react"
import { z } from "zod"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import {
  emptyOnboardingValues,
  prefillFromLead,
  prefillFromQuotation,
  quotationConversionProblem,
  type OnboardingValues,
} from "@/lib/schemas/onboarding"
import { getClientLabel, getLeadForOnboarding, getQuotationForOnboarding, getWizardContext } from "@/lib/data/clients"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { PageGuide } from "@/components/shell/page-slots"
import { OnboardingWizard } from "@/components/clients/onboarding/onboarding-wizard"
import type { WizardSetup, WizardSource } from "@/components/clients/onboarding/types"

export const metadata: Metadata = { title: "Add client" }

type SearchParams = Record<string, string | string[] | undefined>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ""
const isUuid = (v: string) => z.uuid().safeParse(v).success

function Unavailable({ title, message, actions }: { title: string; message: string; actions: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Add client" }]} title="Add client" />
      <section className="flex max-w-2xl gap-3 rounded-lg border border-border bg-surface px-5 py-4">
        <CircleSlashIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-text">{title}</h2>
          <p className="mt-1 text-base text-text-muted">{message}</p>
          <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
        </div>
      </section>
    </div>
  )
}

/**
 * Add client (§7.3.2): the five-step wizard in a full-screen dialog. Partners and Managers only
 * (Employees can't create clients, §4.1). `?fromQuotation=<id>` opens it pre-filled from an
 * accepted quotation with the services locked; `?fromLead=<id>` pre-fills from a lead (§7.5.1).
 */
export default async function NewClientPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const fromQuotation = one(sp.fromQuotation)
  const fromLead = one(sp.fromLead)

  if ((fromQuotation && !isUuid(fromQuotation)) || (fromLead && !isUuid(fromLead))) {
    return (
      <Unavailable
        title="This link isn't complete"
        message="The quotation or lead in the address isn't one the app recognises. Open it from the quotation or the lead instead."
        actions={
          <Button asChild variant="outline">
            <Link href="/clients/new">Add a client from scratch</Link>
          </Button>
        }
      />
    )
  }

  type Loaded =
    | { kind: "ready"; setup: WizardSetup; initial: OnboardingValues; source: WizardSource; locked: boolean }
    | { kind: "unavailable"; title: string; message: string; links: Array<{ href: string; label: string }> }

  let loaded: Loaded
  try {
    const ctx = await getWizardContext(supabase, user.role)
    const base: OnboardingValues = {
      ...emptyOnboardingValues({ clientCode: ctx.clientCode, reminderDays: ctx.reminderDays, notifyChannels: ctx.notifyChannels }),
      owner_employee_id: user.employeeId && ctx.staff.some((s) => s.id === user.employeeId) ? user.employeeId : "",
    }
    const setup: WizardSetup = {
      today: ctx.today,
      clientCode: ctx.clientCode,
      reminderDays: ctx.reminderDays,
      notifyChannels: ctx.notifyChannels,
      staff: ctx.staff,
      scale: ctx.scale,
      sacByService: ctx.sacByService,
      defaultSac: ctx.defaultSac,
      viewer: { role: user.role === "partner" ? "partner" : "manager", employeeId: user.employeeId },
    }

    if (fromQuotation) {
      const q = await getQuotationForOnboarding(supabase, fromQuotation)
      if (!q) {
        loaded = { kind: "unavailable", title: "Quotation not found", message: "It may have been deleted. Open the quotations list to find it.", links: [{ href: "/quotations", label: "Quotations" }] }
      } else if (q.client_id) {
        const c = await getClientLabel(supabase, q.client_id)
        loaded = {
          kind: "unavailable",
          title: "This quotation is for an existing client",
          message: `Quotation ${q.quotation_number} was raised for ${c ? `${c.display_name} (${c.client_code})` : "a client already in the list"}. Add its services on that client's page instead.`,
          links: [
            ...(c ? [{ href: `/clients/${c.id}`, label: `Open ${c.display_name}` }] : []),
            { href: `/quotations/${q.id}`, label: "Open the quotation" },
          ],
        }
      } else {
        const problem = quotationConversionProblem(q)
        if (problem) {
          const c = q.converted_client_id ? await getClientLabel(supabase, q.converted_client_id) : null
          loaded = {
            kind: "unavailable",
            title: q.converted_client_id ? "Already converted" : "Not accepted yet",
            message: problem,
            links: [...(c ? [{ href: `/clients/${c.id}`, label: `Open ${c.display_name}` }] : []), { href: `/quotations/${q.id}`, label: "Open the quotation" }],
          }
        } else {
          const lead = q.lead_id ? await getLeadForOnboarding(supabase, q.lead_id) : null
          loaded = {
            kind: "ready",
            setup,
            initial: prefillFromQuotation(base, q, lead),
            source: { kind: "quotation", id: q.id, number: q.quotation_number, leadId: q.lead_id },
            locked: true,
          }
        }
      }
    } else if (fromLead) {
      const lead = await getLeadForOnboarding(supabase, fromLead)
      if (!lead) {
        loaded = { kind: "unavailable", title: "Lead not found", message: "It may have been deleted. Open the leads list to find it.", links: [{ href: "/leads", label: "Leads" }] }
      } else if (lead.converted_client_id) {
        const c = await getClientLabel(supabase, lead.converted_client_id)
        loaded = {
          kind: "unavailable",
          title: "Already converted",
          message: `${lead.lead_number ? `Lead ${lead.lead_number}` : "This lead"} has already been converted to ${c ? `${c.display_name} (${c.client_code})` : "a client"}.`,
          links: [...(c ? [{ href: `/clients/${c.id}`, label: `Open ${c.display_name}` }] : []), { href: `/leads/${lead.id}`, label: "Open the lead" }],
        }
      } else {
        loaded = { kind: "ready", setup, initial: prefillFromLead(base, lead), source: { kind: "lead", id: lead.id, number: lead.lead_number }, locked: false }
      }
    } else {
      loaded = { kind: "ready", setup, initial: base, source: { kind: "new" }, locked: false }
    }
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/clients/new", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Add client" }]} title="Add client" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load what the wizard needs (the team, the next client code and the settings)." errorRef={ref} />
        </div>
      </div>
    )
  }

  if (loaded.kind === "unavailable") {
    return (
      <Unavailable
        title={loaded.title}
        message={loaded.message}
        actions={
          <>
            {loaded.links.map((l, i) => (
              <Button key={l.href} asChild variant={i === 0 ? "default" : "outline"}>
                <Link href={l.href}>{l.label}</Link>
              </Button>
            ))}
            <Button asChild variant="ghost">
              <Link href="/clients">Back to clients</Link>
            </Button>
          </>
        }
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Add client">
        <p>Five steps, in order: basic information, services, configuration and team, the document checklist, then the compliance setup and a summary. Each step shows a tick when it is complete.</p>
        <p className="mt-2">The draft is saved on this device every few seconds, so you can close the wizard and come back. Complete creates everything at once; notifications, the welcome email and the portal invite follow.</p>
      </PageGuide>
      <PageHeader breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Add client" }]} title="Add client" />
      <OnboardingWizard setup={loaded.setup} initial={loaded.initial} source={loaded.source} servicesLocked={loaded.locked} />
    </div>
  )
}
