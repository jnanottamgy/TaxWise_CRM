import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { isFinancialYear, todayIST } from "@/lib/domain/fy"
import { fyOptions, getSelectedFy } from "@/lib/fy-context"
import { readParam } from "@/components/app/data-table/params"
import { getLetterClientContext, listSignatories, type LetterClientContext } from "@/lib/data/engagement-letters"
import { scheduleFromServices, defaultReportForm, defaultReportingFramework, type CreateLetterInput } from "@/lib/schemas/engagement-letters"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { LetterForm } from "@/components/engagement-letters/letter-form"

export const metadata: Metadata = { title: "New engagement letter" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * New engagement letter (§7.15.3), Partners and Managers only. `?client=<id>` starts it for a client
 * (Client 360 and the "No letter for the FY" list), filling the services and schedule from the
 * client's active services; `?fy=` picks the FY (default: the FY in the top bar).
 */
export default async function NewLetterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const sp = await searchParams
  const today = todayIST()
  const crumbs = [{ label: "Engagement letters", href: "/engagement-letters" }, { label: "New letter" }]
  const clientParam = readParam(sp, "client")
  const clientId = clientParam && UUID.test(clientParam) ? clientParam : null
  const fyParam = readParam(sp, "fy")
  const selected = await getSelectedFy()
  const fy = fyParam && isFinancialYear(fyParam) ? fyParam : selected

  let loaded: { signatories: Awaited<ReturnType<typeof listSignatories>>; context: LetterClientContext | null } | null = null
  let errorRef: string | null = null
  try {
    const [signatories, context] = await Promise.all([listSignatories(supabase), clientId ? getLetterClientContext(supabase, clientId) : Promise.resolve(null)])
    loaded = { signatories, context }
  } catch (err) {
    unstable_rethrow(err)
    errorRef = logUnexpected(err, { source: "page:/engagement-letters/new", userId: user.id })
  }

  if (!loaded) {
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="New engagement letter" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't open the letter form." errorRef={errorRef} />
        </div>
      </div>
    )
  }

  const { signatories, context } = loaded
  const services = context ? [...new Set(context.services.map((s) => s.service_type))] : []
  const audit = services.includes("audit")
  const me = signatories.find((s) => s.id === user.id)
  const years = fyOptions(today)
  if (!years.includes(fy)) years.unshift(fy)
  const initial: CreateLetterInput = {
    clientId: context?.client.id ?? "",
    financialYear: fy,
    serviceTypes: services,
    scope: "",
    exclusions: "",
    feeAgreed: "",
    servicesSchedule: context ? scheduleFromServices(context.services.filter((s) => s.service_type !== "audit")).map((r) => ({ ...r, fee: r.fee ?? "" })) : [],
    expiresAt: "",
    auditType: audit ? "statutory_companies_act" : "",
    reportingFramework: audit ? defaultReportingFramework("statutory_companies_act", context?.client.entityType ?? null, fy) : "",
    reportForm: audit ? defaultReportForm("statutory_companies_act", fy) : "",
    auditEngagementId: context?.engagements.find((e) => e.financial_year === fy)?.id ?? "",
    signatoryId: me?.id ?? (signatories.length === 1 ? signatories[0].id : ""),
    notes: "",
  }
  const missing = clientParam && !context

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="New engagement letter">
        <p>Choose the client and FY; the client&apos;s active services fill the services and the schedule with their agreed fees, which you can change.</p>
        <p className="mt-2">For an audit, the letter carries the SA 210 terms: the objective and scope, each side&apos;s responsibilities, the applicable framework and the expected form of the report. Defaults are filled for the kind of audit and edited for the client.</p>
        <p className="mt-2">It saves as a Draft. Issue it, send it for signature, then record the signed copy on the letter.</p>
      </PageGuide>
      <PageHeader breadcrumbs={crumbs} title="New engagement letter" description={context ? `For ${context.client.name}, FY ${fy}` : `FY ${fy}`} />
      {missing ? (
        <p role="note" className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-base text-text">
          That client couldn&apos;t be found (it may be in the recycle bin), so the letter starts blank.
        </p>
      ) : null}
      <LetterForm
        mode="create"
        initial={initial}
        clientLabel={context ? `${context.client.name} · ${context.client.code}` : null}
        context={{ fyOptions: years, signatories, engagements: context?.engagements ?? [], entityType: context?.client.entityType ?? null }}
      />
    </div>
  )
}
