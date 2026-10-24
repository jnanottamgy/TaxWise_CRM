import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { paiseToDecimalString, toPaise } from "@/lib/domain/money"
import { fyOptions } from "@/lib/fy-context"
import { getLetter, getLetterClientContext, listSignatories, type LetterRow } from "@/lib/data/engagement-letters"
import { LETTER_AUDIT_TYPES, type CreateLetterInput, type LetterAuditType } from "@/lib/schemas/engagement-letters"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { Button } from "@/components/ui/button"
import { ShellTitle } from "@/components/shell/page-slots"
import { LetterForm } from "@/components/engagement-letters/letter-form"

export const metadata: Metadata = { title: "Edit engagement letter" }

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function valuesOf(l: LetterRow): CreateLetterInput {
  return {
    clientId: l.client_id,
    financialYear: l.financial_year,
    serviceTypes: l.service_types,
    scope: l.scope ?? "",
    exclusions: l.exclusions ?? "",
    feeAgreed: l.fee_agreed === null ? "" : paiseToDecimalString(toPaise(l.fee_agreed)),
    servicesSchedule: l.services_schedule.map((r) => ({ ...r, fee: r.fee ?? "" })),
    expiresAt: l.expires_at ?? "",
    auditType: (LETTER_AUDIT_TYPES as readonly string[]).includes(l.audit_type ?? "") ? (l.audit_type as LetterAuditType) : "",
    reportingFramework: l.reporting_framework ?? "",
    reportForm: l.report_form ?? "",
    auditEngagementId: l.audit_engagement_id ?? "",
    signatoryId: l.signatory_id ?? "",
    notes: l.notes ?? "",
  }
}

/**
 * Edit a draft engagement letter (§7.15.3). Only a Draft is edited: once issued, what the client
 * signs is fixed (the database refuses it too), so an issued letter sends you back to it with the
 * way to change it (withdraw to a draft). Partners and Managers only.
 */
export default async function EditLetterPage({ params }: Params) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const today = todayIST()

  let loaded: { letter: LetterRow | null; signatories: Awaited<ReturnType<typeof listSignatories>> } | null = null
  let ref: string | null = null
  try {
    const [letter, signatories] = await Promise.all([getLetter(supabase, id), listSignatories(supabase)])
    loaded = { letter, signatories }
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:/engagement-letters/[id]/edit", userId: user.id })
  }
  const baseCrumbs = [{ label: "Engagement letters", href: "/engagement-letters" }, { label: "Edit" }]
  if (!loaded) {
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={baseCrumbs} />
        <PageHeader breadcrumbs={baseCrumbs} title="Edit engagement letter" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't open the letter." errorRef={ref} />
        </div>
      </div>
    )
  }
  const l = loaded.letter
  if (!l) notFound()
  const crumbs = [{ label: "Engagement letters", href: "/engagement-letters" }, { label: `${l.client_name} · FY ${l.financial_year}`, href: `/engagement-letters/${l.id}` }, { label: "Edit" }]

  if (l.status !== "draft") {
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        <PageHeader breadcrumbs={crumbs} title="This letter can't be edited" />
        <section className="max-w-xl rounded-lg border border-border bg-surface px-5 py-5">
          <p className="text-base text-text">It has been issued, so what the client signs is fixed. To change it, open the letter and withdraw it to a draft, or renew it for the next FY.</p>
          <div className="mt-4">
            <Button asChild>
              <Link href={`/engagement-letters/${l.id}`}>Open the letter</Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  let context: Awaited<ReturnType<typeof getLetterClientContext>> = null
  try {
    context = await getLetterClientContext(supabase, l.client_id)
  } catch (err) {
    unstable_rethrow(err)
    logUnexpected(err, { source: "page:/engagement-letters/[id]/edit:context", userId: user.id })
  }
  const years = fyOptions(today)
  if (!years.includes(l.financial_year)) years.unshift(l.financial_year)

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageHeader breadcrumbs={crumbs} title="Edit draft letter" description={`${l.client_name}, FY ${l.financial_year}`} />
      <LetterForm
        mode="edit"
        initial={valuesOf(l)}
        letter={{ id: l.id, updatedAt: l.updated_at }}
        clientLabel={`${l.client_name} · ${l.client_code}`}
        context={{ fyOptions: years, signatories: loaded.signatories, engagements: context?.engagements ?? [], entityType: context?.client.entityType ?? null }}
      />
    </div>
  )
}
