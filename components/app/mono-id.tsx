import { cn } from "@/lib/utils"
import { EMPTY } from "@/lib/format"
import { CopyButton } from "@/components/app/copy-button"

/**
 * A code or identifier in monospace at body size, with an optional copy button 4px after it:
 * client codes, PAN, GSTIN, TAN, invoice numbers, ARNs, UDINs, Refs. Server-safe.
 *
 *   <MonoId value="TW-C-0042" copy label="Client code" />
 *   <MonoId value={arn} copy label="ARN" truncate={10} />   → AA29102600… (full value on hover and copy)
 */
export function MonoId({
  value,
  copy = false,
  label = "value",
  truncate,
  className,
}: {
  value: string | null | undefined
  copy?: boolean
  /** Names the value for the copy button: "Copy GSTIN". */
  label?: string
  /** Show at most this many characters, then an ellipsis (copy still copies the whole value). */
  truncate?: number
  className?: string
}) {
  if (!value) {
    return (
      <span className={cn("text-text-muted", className)} aria-label={`No ${label}`}>
        {EMPTY}
      </span>
    )
  }
  const shown = truncate && value.length > truncate ? `${value.slice(0, truncate)}…` : value
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-middle", className)}>
      <span
        className={cn("font-mono text-[13px] leading-5 tracking-normal text-text", truncate ? "truncate" : "[overflow-wrap:anywhere]")}
        title={shown !== value ? value : undefined}
      >
        {shown}
      </span>
      {copy ? <CopyButton value={value} label={label} /> : null}
    </span>
  )
}
