import { cn } from "@/lib/utils"

/**
 * A notice on the client's quotation page (§7.23): accepted, declined, expired, replaced, a staff
 * preview, or a page that didn't load. Icon, a short title and one or two sentences. Server-safe.
 */
export function PublicNotice({
  tone,
  icon,
  title,
  children,
  className,
}: {
  tone: "success" | "danger" | "muted" | "info" | "warning"
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
  className?: string
}) {
  const cls = {
    success: "border-success/40 bg-success-soft",
    danger: "border-danger/30 bg-danger-soft",
    muted: "border-border bg-surface-2",
    info: "border-info/40 bg-info-soft",
    warning: "border-warning/40 bg-warning-soft",
  }[tone]
  return (
    <section role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg border px-4 py-3.5", cls, className)}>
      {icon ? <span className="mt-0.5 flex-none [&_svg]:size-5">{icon}</span> : null}
      <div className="min-w-0">
        <h2 className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">{title}</h2>
        <p className="mt-0.5 text-base text-text">{children}</p>
      </div>
    </section>
  )
}
