import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import { formatDate, formatDateTime, pdfFileName } from "@/lib/format"
import { taxYearLabel } from "@/lib/domain/fy"
import { parseRuleSet } from "@/lib/domain/itr-rulesets"
import type { ItrResult } from "@/lib/domain/itr"
import { readParam } from "@/components/app/data-table/params"
import { REGIME_LABEL, computeStored, sameResult, storedToForm } from "@/lib/schemas/itr"
import { getItrClientFacts, getItrComputation, getItrEditorContext, ruleSetFor, type ItrClientFacts, type ItrDetail, type ItrEditorContext } from "@/lib/data/itr"
import { documentShare, getShareContextOrNull, type DocumentShare, type ShareContext } from "@/lib/data/document-share"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { SectionCard } from "@/components/app/section-card"
import { DefinitionList } from "@/components/app/definition-list"
import { MonoId } from "@/components/app/mono-id"
import { PageGuide, ShellTitle } from "@/components/shell/page-slots"
import { ItrEditor } from "@/components/workpapers/itr/itr-editor"
import { ItrComparison, ItrInterestDetails, ItrSheet } from "@/components/workpapers/itr/itr-sheet"
import { ItrStatusActions } from "@/components/workpapers/itr/itr-status-actions"
import { ItrInputsSummary } from "@/components/workpapers/itr/itr-inputs-summary"
import { ItrNote, ItrStatusChip, ItrViewTabs } from "@/components/workpapers/itr/itr-ui"

type Params = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const { id } = await params
    if (!UUID.test(id)) return { title: "ITR computation" }
    const s = await getSession()
    if (s.status !== "ok" || s.user.role === "client") return { title: "ITR computation" }
    const { data } = await s.supabase.from("itr_computations_list").select("client_name, financial_year").eq("id", id).maybeSingle()
    return { title: data ? `ITR · ${data.client_name} · ${taxYearLabel(data.financial_year ?? "")}` : "ITR computation" }
  } catch (err) {
    unstable_rethrow(err)
    return { title: "ITR computation" }
  }
}

const BASE_CRUMBS = [
  { label: "Workpapers", href: "/workpapers" },
  { label: "ITR computation", href: "/workpapers/itr" },
]

/**
 * One ITR computation (§6.11, §7.8.2): the comparison and the recommended regime with the saving,
 * the side-by-side sheet with every line explained, the interest workings, and who prepared,
 * reviewed and finalised it. The figures shown are recomputed here, on the server, from the stored
 * inputs and the rule set they were saved with; a stored result that no longer matches is flagged.
 * Inputs: the editor (a draft autosaves) or, once final, the inputs read-only. Staff who can see
 * the client (RLS); a computation the viewer can't see is a 404.
 */
export default async function ItrPage({ params, searchParams }: Params) {
  const { user, supabase } = await requireStaff()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const sp = await searchParams

  let detail: ItrDetail | null = null
  let ctx: ItrEditorContext | null = null
  let client: ItrClientFacts | null = null
  let shareCtx: ShareContext | null = null
  try {
    ;[detail, ctx] = await Promise.all([getItrComputation(supabase, id), getItrEditorContext(supabase)])
    if (detail) {
      ;[client, shareCtx] = await Promise.all([
        getItrClientFacts(supabase, detail.row.client_id),
        getShareContextOrNull(supabase, user, detail.row.client_id, { source: "page:/workpapers/itr/[id]:share" }),
      ])
    }
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/workpapers/itr/[id]", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={[...BASE_CRUMBS, { label: "Computation" }]} />
        <PageHeader breadcrumbs={[...BASE_CRUMBS, { label: "Computation" }]} title="ITR computation" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load this computation." errorRef={ref} />
        </div>
      </div>
    )
  }
  if (!detail || !ctx) notFound()

  const row = detail.row
  const yearLabel = row.year_label ?? taxYearLabel(row.financial_year)
  const crumbs = [...BASE_CRUMBS, { label: `${row.client_name} · ${yearLabel}` }]
  const viewParam = readParam(sp, "view")
  const view: "sheet" | "inputs" = viewParam === "inputs" || viewParam === "sheet" ? viewParam : row.status === "draft" ? "inputs" : "sheet"
  const role = user.role === "partner" ? "partner" : user.role === "manager" ? "manager" : "employee"

  // Recompute from the stored inputs and the rule set they were saved with (§5.10 "never trusted").
  let fresh: ItrResult | null = null
  let recomputeError: string | null = null
  const snapshot = detail.ruleSetRaw ? parseRuleSet(detail.ruleSetRaw) : null
  if (detail.inputs && snapshot?.ok) {
    try {
      const c = computeStored(detail.inputs, snapshot.ruleSet)
      if (c.ok) fresh = c.result
      else recomputeError = Object.values(c.fieldErrors)[0]?.[0] ?? "The saved inputs can't be computed."
    } catch (err) {
      recomputeError = `The saved inputs can't be computed (Ref ${logUnexpected(err, { source: "page:/workpapers/itr/[id]:recompute", userId: user.id })}).`
    }
  } else {
    recomputeError = detail.inputs ? "The rule set saved with this computation can't be read." : "The saved inputs are in a form this version can't read."
  }
  const result = fresh ?? detail.results
  const mismatch = fresh !== null && detail.results !== null && !sameResult(fresh, detail.results)
  const current = ruleSetFor(ctx.rows, row.financial_year)
  const rulesChanged = row.status !== "final" && current.ok && detail.ruleSetRaw !== null && (current.paramId !== detail.ruleSetParamId || !sameResult(current.raw, detail.ruleSetRaw))
  const canEditClient = Boolean(client && client.eligible)
  const hasBusiness = (detail.inputs?.engine.income.businessProfession ?? 0) > 0

  // The computation goes to the client on WhatsApp with its PDF (§7.13.2).
  const regime = row.regime_chosen ?? result?.recommendedRegime ?? null
  const share: DocumentShare | null = shareCtx
    ? documentShare(shareCtx, {
        serviceType: "income_tax",
        draft: (first) =>
          `${first ? `Hi ${first}` : "Hello"}, please find the income tax computation for ${yearLabel}${regime ? ` (${REGIME_LABEL[regime].toLowerCase()})` : ""}. Please go through it and tell us if anything needs to change before we file the return.`,
        values: { compliance_type: "ITR", service_type: "Income tax", period: yearLabel, due_date: row.due_date ? formatDate(row.due_date) : "" },
        templateTypes: ["custom"],
        attachment: { href: `/api/pdf/itr/${row.id}?download=1`, filename: pdfFileName(`${row.client_code} ${yearLabel}`, "ITR computation") },
        related: { type: "itr_computation", id: row.id },
      })
    : null

  const actions = (
    <ItrStatusActions
      id={row.id}
      updatedAt={row.updated_at}
      status={row.status}
      preparedBy={row.prepared_by}
      viewer={{ id: user.id, role }}
      recommended={result?.recommendedRegime ?? null}
      chosen={row.regime_chosen}
      totals={result ? { new: result.regimes.new.totalTaxAndInterest, old: result.regimes.old.totalTaxAndInterest } : null}
      view={view}
      hasBusiness={hasBusiness}
      share={share}
    />
  )

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={crumbs} />
      <PageGuide title="ITR computation">
        <p>The figures on this page are worked out again on the server each time it opens, from the saved inputs and the rule set they were saved with. The PDF prints the same figures.</p>
        <p className="mt-2">
          A reviewer other than the preparer marks it Reviewed and records the regime chosen; a Manager or Partner marks it Final, which locks it. Changing the figures of a reviewed computation sends it back to
          Draft.
        </p>
      </PageGuide>
      <PageHeader
        breadcrumbs={crumbs}
        title={row.client_name}
        meta={
          <>
            <span className="text-base text-text-muted">{yearLabel}</span>
            <ItrStatusChip status={row.status} variant="pill" />
          </>
        }
        description={[row.label, `${row.client_code}`, row.prepared_by_name ? `Prepared by ${row.prepared_by_name}` : null, `Updated ${formatDateTime(row.updated_at)}`].filter(Boolean).join(" · ")}
        actions={actions}
      />

      {row.status === "draft" && detail.reviewNote ? (
        <ItrNote tone="warning" title="Sent back to Draft">
          {detail.reviewNote}
        </ItrNote>
      ) : null}
      {row.rule_set_verified === false ? (
        <ItrNote title="The rule set for this year awaits a Partner's confirmation">
          Some numbers or section references in the FY {row.financial_year} rule set are marked [verify] on the Law &amp; rules page. Check them before relying on this computation.
        </ItrNote>
      ) : null}
      {rulesChanged ? (
        <ItrNote tone="info" title="The rules for this year were updated after this computation was saved">
          Open Inputs and save to compute it with the current rule set. The figures below use the rules it was saved with.
        </ItrNote>
      ) : null}
      {mismatch ? (
        <ItrNote tone="warning" title="The saved figures differ from a fresh computation">
          The figures below are the fresh computation from the saved inputs.{" "}
          {row.status === "final" ? "A Manager or Partner can reopen it and save again to store them." : "Save the inputs again to store them."}
        </ItrNote>
      ) : null}
      {recomputeError && !result ? (
        <div className="mb-4 rounded-lg border border-border bg-surface">
          <ErrorBlock message={recomputeError} />
        </div>
      ) : null}

      <ItrViewTabs id={row.id} active={view} />

      {view === "sheet" ? (
        result ? (
          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-6">
            <div className="flex min-w-0 flex-col gap-4">
              <ItrComparison result={result} chosen={row.regime_chosen} />
              <ItrSheet result={result} />
              <ItrInterestDetails result={result} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <SectionCard title="Record">
                <DefinitionList
                  items={[
                    { term: "Client", value: <Link href={`/clients/${row.client_id}?tab=workpapers`} className="text-text underline-offset-4 hover:underline">{row.client_name}</Link> },
                    { term: "PAN", value: row.client_pan ? <MonoId value={row.client_pan} copy label="PAN" /> : null },
                    { term: "Year", value: `FY ${row.financial_year} · ${yearLabel}` },
                    { term: "Regime chosen", value: row.regime_chosen ? `${REGIME_LABEL[row.regime_chosen]}${detail.regimeChosenByName ? `, by ${detail.regimeChosenByName}` : ""}` : "Recorded at review" },
                    { term: "Prepared by", value: row.prepared_by_name },
                    { term: "Reviewed", value: row.reviewed_at ? `${row.reviewed_by_name ?? "Someone"}, ${formatDateTime(row.reviewed_at)}` : null },
                    { term: "Final", value: row.finalised_at ? `${row.finalised_by_name ?? "Someone"}, ${formatDateTime(row.finalised_at)}` : null },
                    { term: "Filing date", value: row.filing_date ? formatDate(row.filing_date) : null },
                    { term: "Due date of the return", value: row.due_date ? formatDate(row.due_date) : null },
                    { term: "Computed", value: detail.computedAt ? formatDateTime(detail.computedAt) : null },
                  ]}
                />
              </SectionCard>
            </div>
          </div>
        ) : null
      ) : row.status === "final" ? (
        detail.inputs ? (
          <>
            <ItrNote>This computation is final, so its inputs are locked. A Manager or Partner can reopen it as a draft.</ItrNote>
            <ItrInputsSummary inputs={detail.inputs} />
          </>
        ) : null
      ) : detail.inputs && canEditClient && client ? (
        <ItrEditor
          mode="edit"
          initial={storedToForm(detail.inputs, { id: row.id, updated_at: row.updated_at, client_id: row.client_id, label: row.label })}
          computation={{ id: row.id, status: row.status, updatedAt: row.updated_at }}
          client={{ id: client.id, label: `${client.client_code} · ${client.display_name}`, assesseeType: client.assesseeType, dateOfBirth: client.date_of_birth, taxAuditApplicable: client.tax_audit_applicable }}
          fyOptions={ctx.years.includes(row.financial_year) ? ctx.years : [row.financial_year, ...ctx.years]}
          ruleSets={ctx.ruleSets}
          dueDates={ctx.dueDates}
          canDelete={role !== "employee"}
        />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message={client && !client.eligible ? "This client is no longer recorded as an individual or a HUF, so the computation can't be edited." : "The saved inputs can't be opened for editing."} />
        </div>
      )}
    </div>
  )
}
