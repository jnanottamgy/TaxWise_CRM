import type { Metadata } from "next"
import { notFound, redirect, unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { getBuilderSettings, getQuotationDetail, type BuilderSettings, type QuotationDetail } from "@/lib/data/quotations"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { QuotationBuilder } from "@/components/quotations/builder/quotation-builder"
import { draftBuilderValues, draftPartyLabel } from "@/components/quotations/builder/builder-initial"

export const metadata: Metadata = { title: "Edit quotation" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Edit a Draft quotation (§7.5.2), including one a Partner returned with comments and a new
 * revision. Anything that has gone out (or waits for approval) is never edited in place (§7.5.3):
 * this sends it back to its page, where it can be revised.
 */
export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  let loaded: { detail: QuotationDetail; settings: BuilderSettings } | null = null
  let errorRef: string | null = null
  try {
    const [detail, settings] = await Promise.all([getQuotationDetail(supabase, id), getBuilderSettings(supabase)])
    if (detail && !detail.q.deleted_at) loaded = { detail, settings }
  } catch (err) {
    unstable_rethrow(err)
    errorRef = logUnexpected(err, { source: "page:/quotations/[id]/edit", userId: user.id })
  }
  if (!loaded && !errorRef) notFound()
  if (loaded && loaded.detail.q.status !== "draft") redirect(`/quotations/${id}`)

  const guide = (
    <PageGuide title="Editing a draft">
      <p>Only a Draft can be changed. It saves itself every few seconds; if someone else saves it in between, you are asked to reload instead of overwriting their changes.</p>
      <p className="mt-2">Review &amp; send opens the quotation to send it, or to submit it for a Partner&apos;s approval when it is over the limit.</p>
    </PageGuide>
  )

  if (!loaded) {
    const crumbs = [{ label: "Quotations", href: "/quotations" }, { label: "Edit draft" }]
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={crumbs} />
        {guide}
        <PageHeader breadcrumbs={crumbs} title="Edit quotation" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't open this quotation for editing." errorRef={errorRef ?? undefined} />
        </div>
      </div>
    )
  }

  const { detail, settings } = loaded
  const q = detail.q
  const crumbs = [{ label: "Quotations", href: "/quotations" }, { label: q.quotation_number, href: `/quotations/${id}` }, { label: "Edit" }]
  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      {guide}
      <PageHeader breadcrumbs={crumbs} title={`Edit ${q.quotation_number}`} description={`Draft${q.revision_number ? `, revision ${q.revision_number}` : ""} · prepared by ${q.created_by_name ?? "a former colleague"}`} />
      <QuotationBuilder
        initial={draftBuilderValues(detail, settings.firmStateCode)}
        partyLabel={draftPartyLabel(detail)}
        context={{ today: settings.today, validityDays: settings.validityDays, firmStateCode: settings.firmStateCode, approvalLimitPaise: settings.approvalLimitPaise }}
        authorRole={q.created_by_role === "partner" ? "partner" : "manager"}
        quotation={{
          id: q.id,
          number: q.quotation_number,
          revisionNumber: q.revision_number,
          revises: detail.revisedFrom ? { id: detail.revisedFrom.id, number: detail.revisedFrom.quotation_number } : null,
          returnedAt: q.returned_at,
          returnNote: q.returned_at ? q.approval_note : null,
          updatedAt: q.updated_at,
        }}
        storageKey={`quotation:${q.id}`}
      />
    </div>
  )
}
