import Link from "next/link"
import { cn } from "@/lib/utils"
import { EMPTY } from "@/lib/format"
import { formatINR, formatINRCompact, type Paise } from "@/lib/domain/money"
import { FullValueHint } from "@/components/app/full-value-hint"
import { StatusChip } from "@/components/app/status-chip"
import { ITR_STATUS_INFO, REGIME_LABEL, type ItrStatus } from "@/lib/schemas/itr"
import type { Regime } from "@/lib/domain/itr-rulesets"

/** Draft · Reviewed · Final, explained on hover (§3.4, §7.8.2). Server-safe. */
export function ItrStatusChip({ status, variant }: { status: ItrStatus; variant?: "dot" | "pill" }) {
  const info = ITR_STATUS_INFO[status] ?? ITR_STATUS_INFO.draft
  return <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} variant={variant} />
}

/**
 * A tax figure the engine computed in integer paise: `₹1,23,456` (whole rupees print without paise,
 * as on a computation sheet), tabular figures, negatives with a minus. `compact` only for headline
 * figures, with the full value on hover (§3.4). A missing value is a grey em dash; a real zero
 * prints. Server-safe.
 */
export function TaxFigure({ value, compact = false, className }: { value: Paise | null | undefined; compact?: boolean; className?: string }) {
  const base = cn("num whitespace-nowrap tabular-nums", className)
  if (value === null || value === undefined || !Number.isSafeInteger(value)) {
    return (
      <span className={cn(base, "text-text-muted")} aria-label="No amount">
        {EMPTY}
      </span>
    )
  }
  const full = taxAmount(value)
  if (compact) {
    const short = formatINRCompact(value)
    if (short !== full && Math.abs(value) >= 10_000_000) return <FullValueHint short={short} full={full} className={base} />
  }
  return <span className={base}>{full}</span>
}

/** ₹1,23,456 for whole rupees, ₹1,23,456.50 otherwise (minus sign for negatives). */
export function taxAmount(value: Paise): string {
  const v = value === 0 ? 0 : value
  return v % 100 === 0 ? formatINR(v, { decimals: 0 }) : formatINR(v)
}

export function regimeName(r: Regime | null | undefined): string {
  return r ? REGIME_LABEL[r] : EMPTY
}

/** The balance as words with the figure: "Payable ₹12,340" / "Refund ₹4,560" / "Nil". */
export function BalanceText({ balance, className }: { balance: Paise | null | undefined; className?: string }) {
  if (balance === null || balance === undefined) return <span className={cn("text-text-muted", className)}>{EMPTY}</span>
  if (balance === 0) return <span className={cn("text-text-muted", className)}>Nil</span>
  return (
    <span className={cn("inline-flex items-baseline gap-1.5 whitespace-nowrap", className)}>
      <span className="text-sm text-text-muted">{balance > 0 ? "Payable" : "Refund"}</span>
      <TaxFigure value={Math.abs(balance)} />
    </span>
  )
}

/** "Computation" / "Inputs" underline tabs (links, so a view is shareable). Server-safe. */
export function ItrViewTabs({ id, active }: { id: string; active: "sheet" | "inputs" }) {
  const tabs = [
    { key: "sheet" as const, label: "Computation" },
    { key: "inputs" as const, label: "Inputs" },
  ]
  return (
    <nav aria-label="Computation views" className="-mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max items-center gap-0.5 border-b border-border">
        {tabs.map((t) => {
          const on = t.key === active
          return (
            <li key={t.key}>
              <Link
                href={`/workpapers/itr/${id}?view=${t.key}`}
                scroll={false}
                prefetch={false}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
                  on ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text",
                )}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** A note band above content (rule set awaiting confirmation, figures out of date, sent back). Server-safe. */
export function ItrNote({ tone = "neutral", title, children }: { tone?: "neutral" | "warning" | "info"; title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      role="note"
      className={cn(
        "mb-4 rounded-md border px-3 py-2.5 text-base text-text",
        tone === "warning" ? "border-warning/40 bg-warning-soft" : tone === "info" ? "border-info/30 bg-info-soft" : "border-border bg-surface-2",
      )}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? "mt-0.5" : undefined}>{children}</div>
    </div>
  )
}
