import { CircleCheckIcon, CircleMinusIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { StatementCheck } from "@/lib/domain/schedule3"
import { PaiseAmount } from "@/components/workpapers/shared/amount"

const STATE = {
  pass: { label: "Passes", Icon: CircleCheckIcon, tone: "text-success-text" },
  fail: { label: "Fails", Icon: CircleXIcon, tone: "text-danger-text" },
  skipped: { label: "Not run", Icon: CircleMinusIcon, tone: "text-text-muted" },
} as const

function CheckRow({ c }: { c: StatementCheck }) {
  const s = STATE[c.status]
  return (
    <li className="flex gap-3 border-t border-border px-4 py-3 md:px-5">
      <s.Icon aria-hidden="true" className={cn("mt-0.5 size-4 flex-none", s.tone)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-baseline md:justify-between md:gap-4">
        <div className="min-w-0">
          <p className="text-base text-text">
            {c.title} <span className={cn("text-sm font-medium", s.tone)}>· {s.label}</span>
          </p>
          <p className="text-sm text-text-muted">{c.message}</p>
        </div>
        {c.status === "fail" && c.difference !== null && c.difference !== 0 ? (
          <span className="flex-none text-sm text-text">
            Difference <PaiseAmount value={Math.abs(c.difference)} />
          </span>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The checks, shown prominently (§6.13): trial balance agrees, balance sheet balances, every ledger
 * mapped, profit equals the movement in capital and reserves; then opening stock, the ageing
 * schedules and the MSME dues when they apply. Failing checks are listed in full with what was
 * found and the difference; the others fold into one line that opens. Never by colour alone: each
 * says Passes, Fails or Not run. Server-safe.
 */
export function ChecksPanel({ checks, warnings, preview }: { checks: StatementCheck[]; warnings: string[]; preview?: boolean }) {
  const failing = checks.filter((c) => c.status === "fail")
  const others = checks.filter((c) => c.status !== "fail")
  return (
    <section aria-labelledby="fs-checks-title" className={cn("rounded-lg border bg-surface", failing.length ? "border-danger/40" : "border-border")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-3 md:px-5">
        <h2 id="fs-checks-title" className="text-md leading-6 font-semibold text-text">
          Checks
        </h2>
        <p className={cn("text-sm", failing.length ? "text-danger-text" : "text-success-text")}>
          {failing.length ? `${failing.length} of ${checks.length} ${failing.length === 1 ? "fails" : "fail"}` : "Every check passes"}
          {preview ? <span className="text-text-muted"> · including your unsaved changes</span> : null}
        </p>
      </div>
      <ul>
        {failing.map((c) => (
          <CheckRow key={c.code} c={c} />
        ))}
      </ul>
      {others.length ? (
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-text-muted outline-none hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
            <CircleCheckIcon aria-hidden="true" className="size-4 flex-none text-success-text" />
            <span className="min-w-0 truncate">
              {others.map((c) => `${c.title}: ${STATE[c.status].label.toLowerCase()}`).join(" · ")}
            </span>
            <span className="ml-auto flex-none text-text-muted group-open:hidden">Show</span>
            <span className="ml-auto hidden flex-none text-text-muted group-open:inline">Hide</span>
          </summary>
          <ul>
            {others.map((c) => (
              <CheckRow key={c.code} c={c} />
            ))}
          </ul>
        </details>
      ) : null}
      {warnings.length ? (
        <details className="border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-text outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
            <TriangleAlertIcon aria-hidden="true" className="size-4 flex-none text-warning-text" />
            {warnings.length} {warnings.length === 1 ? "balance sits" : "balances sit"} on the unexpected side
          </summary>
          <ul className="flex flex-col gap-1 px-4 pb-3 md:px-5">
            {warnings.slice(0, 20).map((w, i) => (
              <li key={i} className="text-sm text-text-muted">
                {w}
              </li>
            ))}
            {warnings.length > 20 ? <li className="text-sm text-text-muted">{warnings.length - 20} more in the Excel export.</li> : null}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
