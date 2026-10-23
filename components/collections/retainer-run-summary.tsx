import Link from "next/link"
import { formatDate, formatDateTime } from "@/lib/format"
import { formatINR } from "@/lib/domain/money"
import { RETAINER_SKIP_REASONS, RETAINER_SKIP_REASON_LABELS } from "@/lib/domain/invoice"
import type { RetainerRun } from "@/lib/data/collections"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"

/**
 * One run of the retainer job (§7.9.6): what it drafted, every skip reason with its count (as the
 * spec lists them), the engagements that hit the catch-up cap of 3, and any that failed. Earlier
 * runs are a chip away. Server-safe.
 */
export function RetainerRunSummary({ run, runs, selectedRunId }: { run: RetainerRun | null; runs: RetainerRun[]; selectedRunId: string | null }) {
  if (!run) {
    return (
      <SectionCard title="Daily run" description="Runs at 09:30 every day.">
        <EmptyState size="compact" message="The retainer run hasn't run yet. It drafts invoices for engagements set to invoice automatically once their next billing date comes." />
      </SectionCard>
    )
  }
  const c = run.counts
  const skipped = RETAINER_SKIP_REASONS.map((r) => ({ label: RETAINER_SKIP_REASON_LABELS[r], n: c[`skipped_${r}`] ?? 0 }))
  const skippedTotal = skipped.reduce((s, x) => s + x.n, 0)
  return (
    <SectionCard
      title={`Run of ${formatDate(run.runDate)}`}
      description={run.finishedAt ? `Finished ${formatDateTime(run.finishedAt)} · ${c.engagements_checked ?? 0} engagements checked` : "Still running, or stopped before it finished."}
      action={
        runs.length > 1 ? (
          <nav aria-label="Earlier runs" className="flex max-w-full flex-wrap justify-end gap-1.5">
            {runs.slice(0, 5).map((r) => {
              const active = (selectedRunId ?? runs[0].id) === r.id
              return (
                <Link
                  key={r.id}
                  href={r.id === runs[0].id && !selectedRunId ? "/retainer-drafts" : `/retainer-drafts?run=${r.id}&state=all`}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "rounded-full border border-text/50 px-2.5 py-0.5 text-sm font-medium text-text"
                      : "rounded-full border border-border px-2.5 py-0.5 text-sm text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
                  }
                >
                  {formatDate(r.runDate).slice(0, 6)}
                </Link>
              )
            })}
          </nav>
        ) : null
      }
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-text-muted">Drafted</dt>
          <dd className="mt-0.5 text-base text-text">
            <span className="num font-medium">{run.draftsCreated}</span> {run.draftsCreated === 1 ? "invoice" : "invoices"}
            {run.draftsCreated ? <span className="num text-text-muted"> · {formatINR(run.draftsTotalPaise)}</span> : null}
          </dd>
          {c.already_billed ? <dd className="text-text-muted">{c.already_billed} {c.already_billed === 1 ? "period was" : "periods were"} already invoiced and skipped</dd> : null}
        </div>
        <div>
          <dt className="text-text-muted">Skipped ({skippedTotal})</dt>
          <dd className="mt-0.5 text-text">
            {skipped.map((s, i) => (
              <span key={s.label} className="whitespace-nowrap">
                {s.label} <span className="num">{s.n}</span>
                {i < skipped.length - 1 ? <span className="text-text-muted"> · </span> : null}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Still behind after 3 periods</dt>
          {run.capped.length ? (
            <dd className="mt-0.5 text-text">
              <ul className="flex flex-col gap-0.5">
                {run.capped.slice(0, 4).map((x) => (
                  <li key={x.client_service_id}>
                    <Link href={`/clients/${x.client_id}?tab=services`} className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      {x.client_name}
                    </Link>{" "}
                    <span className="text-text-muted">
                      · {x.service} · {x.periods_left} more from {formatDate(x.next_billing_date)}
                    </span>
                  </li>
                ))}
              </ul>
              {run.capped.length > 4 ? <span className="text-text-muted">and {run.capped.length - 4} more; the next runs catch up.</span> : <span className="text-text-muted">The next runs catch up.</span>}
            </dd>
          ) : (
            <dd className="mt-0.5 text-text-muted">None</dd>
          )}
        </div>
      </dl>
      {run.errors.length ? (
        <div role="note" className="mt-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-text">
          <p className="font-medium">
            {run.errors.length} {run.errors.length === 1 ? "engagement" : "engagements"} couldn&apos;t be drafted:
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {run.errors.slice(0, 5).map((e) => (
              <li key={e.client_service_id}>
                <Link href={`/clients/${e.client_id}?tab=services`} className="underline-offset-2 hover:underline">
                  {e.client_name}
                </Link>
                <span className="text-text-muted">: {e.error}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  )
}
