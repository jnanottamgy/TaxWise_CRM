import { unstable_rethrow } from "next/navigation"
import { getSession } from "@/lib/auth/current-user"
import { logUnexpected } from "@/lib/log"
import type { SettingsSlug } from "@/lib/schemas/settings"
import { SettingsNav } from "@/components/settings/settings-nav"

/** The sections a Manager or Employee may open: Settings → WhatsApp, read-only (§7.21, §7.25). */
const STAFF_SECTIONS: readonly SettingsSlug[] = ["whatsapp"]

/**
 * Settings (§7.21): the section list beside the section's own page (one view per section). Renders
 * inside the staff shell (app/(staff)/layout.tsx). Each page checks the role itself: firm sections
 * need a Partner (requirePartner), WhatsApp opens read-only for Managers and Employees, diagnostics
 * is gated on the session alone (§7.24). The list shows a non-Partner only what they may open. The
 * role read is the request's memoised session and never fails the layout (§0.1 rule 3): when it
 * can't be read, the full list shows and each page answers for itself.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  let only: readonly SettingsSlug[] | undefined
  try {
    const session = await getSession()
    if (session.status === "ok" && session.user.role !== "partner") only = STAFF_SECTIONS
  } catch (err) {
    unstable_rethrow(err)
    logUnexpected(err, { source: "layout:/settings:role" })
  }
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:gap-8">
      <aside className="min-w-0 lg:sticky lg:top-20 lg:w-48 lg:flex-none lg:self-start">
        <SettingsNav only={only} />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
