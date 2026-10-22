import { cn } from "@/lib/utils"
import { ROLE_LABEL, type AppRole } from "@/lib/auth/roles"

const ROLE_CLASS: Record<AppRole, string> = {
  // §7.11.1: Partner gold, Manager navy, Employee grey.
  partner: "border-gold/40 bg-gold/10 text-gold-text",
  manager: "border-brand-navy/25 bg-brand-navy/[0.06] text-brand-navy dark:border-primary/30 dark:bg-primary-soft dark:text-primary",
  employee: "border-border bg-surface-2 text-text-muted",
  client: "border-border bg-surface text-text-muted",
}

/**
 * The role badge for people lists, the user card and person headers (§7.11.1).
 *
 *   <RoleBadge role="partner" />   → "Partner" in gold
 */
export function RoleBadge({ role, className }: { role: AppRole; className?: string }) {
  return (
    <span
      data-slot="role-badge"
      className={cn(
        "inline-flex h-5 flex-none items-center rounded-full border px-2 text-xs leading-4 font-medium whitespace-nowrap",
        ROLE_CLASS[role],
        className
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  )
}
