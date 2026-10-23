import { cn } from "@/lib/utils"

const TONE: Record<"info" | "warning" | "danger" | "success" | "muted", string> = {
  info: "border-info/30 bg-info-soft",
  warning: "border-warning/30 bg-warning-soft",
  danger: "border-danger/30 bg-danger-soft",
  success: "border-success/30 bg-success-soft",
  muted: "border-border bg-surface-2",
}

/** A one-line state note above the invoice (awaiting approval, returned, cancelled, disputed, waived). Server-safe. */
export function Notice({ tone, title, children }: { tone: keyof typeof TONE; title: string; children: React.ReactNode }) {
  return (
    <div role="note" className={cn("rounded-md border px-3 py-2.5 text-base text-text", TONE[tone])}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 text-sm text-text">{children}</p>
    </div>
  )
}
