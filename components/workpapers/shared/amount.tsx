import { cn } from "@/lib/utils"
import { EMPTY } from "@/lib/format"
import { formatINR, formatINRCompact, type Paise } from "@/lib/domain/money"
import { FullValueHint } from "@/components/app/full-value-hint"

/**
 * An amount the workpaper engines computed in integer paise (§0.1 rule 7), shown as `₹1,23,456.00`
 * with tabular figures. `compact` (`₹12.3L`, the full value on hover) only for the headline figures
 * (§3.4). `brackets` prints negatives as `(₹500.00)`, as statements do. A missing value is a grey
 * em dash; a real zero prints. Server-safe.
 */
export function PaiseAmount({
  value,
  compact = false,
  brackets = false,
  signed = false,
  muted = false,
  className,
}: {
  value: Paise | null | undefined
  compact?: boolean
  brackets?: boolean
  /** Show a + on positive differences ("2B ₹180.00 more"). */
  signed?: boolean
  muted?: boolean
  className?: string
}) {
  const base = cn("num whitespace-nowrap tabular-nums", muted && "text-text-muted", className)
  if (value === null || value === undefined || !Number.isSafeInteger(value)) {
    return (
      <span className={cn(base, "text-text-muted")} aria-label="No amount">
        {EMPTY}
      </span>
    )
  }
  const full = brackets && value < 0 ? `(${formatINR(-value)})` : `${signed && value > 0 ? "+" : ""}${formatINR(value)}`
  if (compact) {
    const short = formatINRCompact(value)
    if (short !== formatINR(value)) return <FullValueHint short={short} full={full} className={base} />
  }
  return <span className={base}>{full}</span>
}
