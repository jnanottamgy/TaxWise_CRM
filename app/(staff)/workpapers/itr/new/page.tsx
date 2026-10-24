import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { isFinancialYear, todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { readParam } from "@/components/app/data-table/params"
import { ageBandFor, blankItrForm, defaultReturnKind } from "@/lib/schemas/itr"
import { getItrClientFacts, getItrEditorContext, type ItrClientFacts, type ItrEditorContext } from "@/lib/data/itr"
import { PageHeader } from "@/components/app/page-header"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { ShellTitle } from "@/components/shell/page-slots"
import { ItrEditor, type ItrEditorClient } from "@/components/workpapers/itr/itr-editor"
import { ItrNote } from "@/components/workpapers/itr/itr-ui"

export const metadata: Metadata = { title: "New ITR computation" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CRUMBS = [
  { label: "Workpapers", href: "/workpapers" },
  { label: "ITR computation", href: "/workpapers/itr" },
  { label: "New" },
]

/**
 * A new ITR computation (§7.8.2): pick the client (individuals and HUFs the viewer can see) and the
 * year, then the inputs. `?client=` (from Client 360) and `?fy=` preselect them. The first autosave
 * creates the draft and the address becomes the computation's own.
 */
export default async function NewItrPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const today = todayIST()
  const clientParam = readParam(sp, "client")
  const fyParam = readParam(sp, "fy")

  let ctx: ItrEditorContext
  let facts: ItrClientFacts | null = null
  try {
    ;[ctx, facts] = await Promise.all([getItrEditorContext(supabase), clientParam && UUID.test(clientParam) ? getItrClientFacts(supabase, clientParam) : Promise.resolve(null)])
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "page:/workpapers/itr/new", userId: user.id })
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={CRUMBS} />
        <PageHeader breadcrumbs={CRUMBS} title="New ITR computation" />
        <div className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load the income-tax rule sets." errorRef={ref} />
        </div>
      </div>
    )
  }

  if (ctx.years.length === 0) {
    return (
      <div className="flex min-w-0 flex-col">
        <ShellTitle crumbs={CRUMBS} />
        <PageHeader breadcrumbs={CRUMBS} title="New ITR computation" />
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState message="No income-tax rule set is recorded for any year yet. A Partner adds them under Settings → Law & rules; then computations can start." />
        </div>
      </div>
    )
  }

  const selectedFy = await getSelectedFy()
  const fy = fyParam && isFinancialYear(fyParam) && ctx.years.includes(fyParam) ? fyParam : ctx.years.includes(selectedFy) ? selectedFy : ctx.years[0]
  const eligible = facts && facts.eligible ? facts : null
  const kind = defaultReturnKind({ taxAuditApplicable: eligible?.tax_audit_applicable ?? null, businessIncome: false })
  const band = eligible ? (eligible.assesseeType === "huf" ? "below_60" : ageBandFor(eligible.date_of_birth, fy)) : null
  const ruleDue = ctx.dueDates[fy]?.[kind]?.date ?? null
  const initial = blankItrForm({
    clientId: eligible?.id ?? "",
    financialYear: fy,
    ageBand: band ?? "below_60",
    ageBandSource: "auto",
    filingDate: today,
    dueDate: ruleDue ?? today,
    dueDateSource: ruleDue ? "rule" : "manual",
    returnKind: kind,
  })
  const client: ItrEditorClient | null = eligible
    ? { id: eligible.id, label: `${eligible.client_code} · ${eligible.display_name}`, assesseeType: eligible.assesseeType, dateOfBirth: eligible.date_of_birth, taxAuditApplicable: eligible.tax_audit_applicable }
    : null

  return (
    <div className="flex min-w-0 flex-col">
      <ShellTitle crumbs={CRUMBS} />
      <PageHeader breadcrumbs={CRUMBS} title="New ITR computation" description="Both regimes side by side from the same inputs. A draft saves itself every few seconds." />
      {facts && !facts.eligible ? (
        <ItrNote tone="warning" title={`${facts.display_name} isn't an individual or a HUF`}>
          ITR computations here are for individuals and HUFs (a proprietor files as an individual). Choose another client below.
        </ItrNote>
      ) : null}
      {clientParam && !facts ? (
        <ItrNote tone="warning" title="That client isn't in your list">
          It may be in the recycle bin, or not one of your clients. Choose a client below.
        </ItrNote>
      ) : null}
      <ItrEditor
        mode="new"
        initial={initial}
        computation={null}
        client={client}
        fyOptions={ctx.years}
        ruleSets={ctx.ruleSets}
        dueDates={ctx.dueDates}
        canDelete={user.role === "partner" || user.role === "manager"}
      />
    </div>
  )
}
