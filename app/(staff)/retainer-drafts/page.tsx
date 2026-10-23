import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { formatINR } from "@/lib/domain/money"
import { todayIST } from "@/lib/domain/fy"
import { RETAINER_QUEUE_FILTERS, RETAINER_QUEUE_SORTABLE, RETAINER_STATE_LABEL, type RetainerQueueState } from "@/lib/schemas/collections"
import { getRetainerQueueCounts, listRetainerQueue, listRetainerRuns } from "@/lib/data/collections"
import { formatCount, parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { RetainerTable } from "@/components/collections/retainer-table"
import { RetainerRunSummary } from "@/components/collections/retainer-run-summary"
import { IssueAllButton } from "@/components/collections/retainer-issue-all"
import { BlockError } from "@/components/collections/ui"

export const metadata: Metadata = { title: "Retainer drafts" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/retainer-drafts:${source}`, userId }) }
  }
}

/**
 * Retainer drafts (§7.9.6): "What did the daily run draft, and what is left to issue?" The run's
 * summary (drafted, skipped by reason, engagements that hit the catch-up cap), then the queue:
 * waiting to issue, held for a Partner, or issued; searched, sorted and paged in SQL. Issue all /
 * Issue selected sends them (email when it can go). Partners and Managers only (§4.1).
 */
export default async function RetainerDraftsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireManagerOrPartner()
  const role = user.role === "partner" ? "partner" : "manager"
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: RETAINER_QUEUE_SORTABLE, defaultSort: { sort: "billing_date", dir: "asc" }, filters: RETAINER_QUEUE_FILTERS })
  const state = (t.filters.state?.[0] ?? "waiting") as RetainerQueueState
  const runParam = readParam(sp, "run")
  const runId = runParam && UUID.test(runParam) ? runParam : null
  const today = todayIST()

  const [list, counts, runs] = await Promise.all([
    attempt("list", user.id, () => listRetainerQueue(supabase, t, { state, runId })),
    attempt("counts", user.id, () => getRetainerQueueCounts(supabase)),
    attempt("runs", user.id, () => listRetainerRuns(supabase, 12)),
  ])
  const run = runs.ok ? (runId ? (runs.data.find((r) => r.id === runId) ?? null) : (runs.data[0] ?? null)) : null
  const waiting = counts.ok ? counts.data.waiting : 0
  const held = counts.ok ? counts.data.held : 0
  const issueAllCount = role === "partner" ? waiting + held : waiting

  const description = counts.ok
    ? waiting + held
      ? [`${formatCount(waiting)} ready to issue`, held ? `${formatCount(held)} held for a Partner` : null].filter(Boolean).join(" · ")
      : "Nothing waiting to issue."
    : "Draft invoices the daily retainer run made. Nothing is sent until you issue it."

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <PageGuide title="Retainer drafts">
        <p>Every day at 09:30 the retainer run drafts an invoice for each engagement set to invoice automatically whose next billing date has come. It never sends anything: the drafts wait here until you issue them.</p>
        <p className="mt-2">
          It skips an engagement that isn&apos;t enabled, a service that is inactive, a client that is inactive or on hold, an engagement with no agreed fee, a one-time service, or one that
          isn&apos;t due yet. It catches up missed periods three at a time; an engagement still behind is listed and caught up on the next runs.
        </p>
        <p className="mt-2">A draft over the invoice approval limit is held for a Partner: a Partner issues it, and a Manager sends it for approval first.</p>
      </PageGuide>
      <PageHeader
        title="Retainer drafts"
        description={description}
        className="pb-0 md:pb-0"
        actions={issueAllCount > 0 && state !== "issued" ? <IssueAllButton count={issueAllCount} role={role} runId={runId} /> : null}
      />

      {runs.ok ? <RetainerRunSummary run={run} runs={runs.data} selectedRunId={runId} /> : <BlockError title="Daily run" message="Couldn't load the retainer runs." errorRef={runs.ref} />}

      <div className="flex min-w-0 flex-col">
        <FilterBar
          searchLabel="Search retainer drafts"
          searchPlaceholder="Client, code or period"
          filters={[
            {
              id: "state",
              label: "Showing",
              multi: false,
              options: (["waiting", "held", "issued", "all"] as const).map((s) => ({
                value: s,
                label: s === "waiting" && counts.ok ? `${RETAINER_STATE_LABEL[s]} (${formatCount(waiting)})` : s === "held" && counts.ok ? `${RETAINER_STATE_LABEL[s]} (${formatCount(held)})` : RETAINER_STATE_LABEL[s],
              })),
            },
          ]}
        />
        {list.ok ? (
          <>
            <RetainerTable rows={list.data.rows} total={list.data.total} page={t.page} pageSize={t.pageSize} sort={t.sort} dir={t.dir} today={today} state={state} role={role} runId={runId} />
            {list.data.total > 0 ? (
              <p className="num mt-2 text-right text-sm text-text-muted tabular-nums">
                {formatCount(list.data.total)} {list.data.total === 1 ? "draft" : "drafts"} · {formatINR(list.data.totalPaise)} incl. GST
              </p>
            ) : null}
          </>
        ) : (
          <div className="rounded-lg border border-border bg-surface">
            <ErrorBlock message="Couldn't load the retainer drafts." errorRef={list.ref} />
          </div>
        )}
      </div>
    </div>
  )
}
