import { cn } from "@/lib/utils"

/**
 * One section of a settings form (§3.4: sections in cards, two columns on desktop, one on mobile).
 * 1px border on surface, no shadow at rest. Server-safe.
 *
 *   <SettingsCard title="Identity" description="Printed at the top of every invoice and quotation.">
 *     <TextField … />
 *     <TextField … />
 *   </SettingsCard>
 *
 * `columns={1}` for a section of full-width controls (switch rows, a table editor).
 */
export function SettingsCard({
  title,
  description,
  action,
  columns = 2,
  id,
  className,
  bodyClassName,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  /** Right side of the header: one small action. */
  action?: React.ReactNode
  columns?: 1 | 2
  id?: string
  className?: string
  bodyClassName?: string
  children: React.ReactNode
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-slot="settings-card"
      className={cn("min-w-0 rounded-lg border border-border bg-surface", className)}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
        <div className="min-w-0">
          <h2 id={headingId} className="text-md leading-6 font-semibold text-text">
            {title}
          </h2>
          {description ? <p className="mt-0.5 max-w-[72ch] text-sm text-text-muted">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
      </div>
      <div
        className={cn(
          "grid min-w-0 gap-x-6 gap-y-4 px-4 py-4 md:px-5 md:py-5",
          columns === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1",
          bodyClassName
        )}
      >
        {children}
      </div>
    </section>
  )
}

/**
 * "What this setting produces" (taste §8.2): a small, quiet sample next to the control that changes
 * it — the next invoice number, a due date, an amount as it prints. Spans both columns by default.
 */
export function SettingPreview({
  label = "Preview",
  children,
  wide = true,
  className,
}: {
  label?: string
  children: React.ReactNode
  wide?: boolean
  className?: string
}) {
  return (
    <div
      data-slot="setting-preview"
      aria-live="polite"
      className={cn("min-w-0 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm", wide && "md:col-span-2", className)}
    >
      <p className="text-xs font-medium text-text-muted">{label}</p>
      <div className="mt-1 min-w-0 text-text">{children}</div>
    </div>
  )
}

/** A full-width row inside a two-column card (an address, a text block). */
export function Wide({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("min-w-0 md:col-span-2", className)}>{children}</div>
}
