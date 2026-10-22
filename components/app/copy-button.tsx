"use client"

import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/use-copy"

/**
 * Copies a value (PAN, GSTIN, TAN, client code, invoice number, ARN, a Ref) and says "Copied"
 * (§3.4). Icon-only by default with an aria-label naming what it copies; announced to screen readers.
 * Clicks don't bubble, so it is safe inside clickable rows.
 *
 *   <CopyButton value={client.pan} label="PAN" />
 *   <CopyButton value={ref} label="Ref" showText />
 */
export function CopyButton({
  value,
  label,
  showText = false,
  className,
}: {
  value: string
  /** What is copied, for the accessible name: "Copy PAN". */
  label: string
  /** Show "Copy" / "Copied" text beside the icon. */
  showText?: boolean
  className?: string
}) {
  const { copy, copied } = useCopy()
  return (
    <>
    <button
      type="button"
      data-slot="copy-button"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        void copy(value)
      }}
      className={cn(
        "relative inline-flex h-6 flex-none cursor-pointer items-center gap-1 rounded-md px-1 align-middle text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        "pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']",
        copied && "text-success-text hover:text-success-text",
        className
      )}
    >
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
      {showText ? <span>{copied ? "Copied" : "Copy"}</span> : copied ? <span>Copied</span> : null}
    </button>
    <span className="sr-only" role="status" aria-live="polite">
      {copied ? `${label} copied` : ""}
    </span>
    </>
  )
}
