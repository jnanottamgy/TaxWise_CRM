import { SettingsNav } from "@/components/settings/settings-nav"

/**
 * Settings (§7.21): the section list beside the section's own page (one view per section). Renders
 * inside the staff shell (app/(staff)/layout.tsx). It loads nothing, so it can't fail (§0.1 rule 3);
 * each page checks the role itself: firm sections need a Partner (requirePartner), diagnostics is
 * gated on the session alone (§7.24).
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:gap-8">
      <aside className="min-w-0 lg:sticky lg:top-20 lg:w-48 lg:flex-none lg:self-start">
        <SettingsNav />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
