import { headers } from "next/headers"
import { redirect, unstable_rethrow } from "next/navigation"
import { getSession } from "@/lib/auth/current-user"
import { requirePartner, requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { PATH_HEADER } from "@/lib/supabase/proxy"
import { SETTINGS_SECTIONS, type SettingsSlug } from "@/lib/schemas/settings"
import { SettingsNav } from "@/components/settings/settings-nav"

/** The sections a Manager or Employee may open: Settings → WhatsApp, read-only (§7.21, §7.25). */
const STAFF_SECTIONS: readonly SettingsSlug[] = ["whatsapp"]

/**
 * The sections only a Partner may open (§7.21). Diagnostics is left out: it is gated on the verified
 * token alone so it opens when the profiles table is the thing that's broken (§7.24), and its page
 * makes that check itself.
 */
const PARTNER_SECTIONS: ReadonlySet<string> = new Set(SETTINGS_SECTIONS.map((s) => s.slug).filter((s) => s !== "diagnostics" && !STAFF_SECTIONS.includes(s)))

/**
 * The section a request is for, from the path the proxy forwards: `/settings/firm?x=1` → "firm",
 * `/settings` → "" (the index), anything unreadable → null.
 */
async function requestedSection(): Promise<string | null> {
  const path = (await headers()).get(PATH_HEADER)?.split(/[?#]/)[0]?.replace(/\/+$/, "") ?? null
  if (path === "/settings") return ""
  const m = path ? /^\/settings\/([^/]+)/.exec(path) : null
  return m ? m[1] : null
}

/**
 * Settings (§7.21): the section list beside the section's own page (one view per section). Renders
 * inside the staff shell (app/(staff)/layout.tsx). Each page checks the role itself: firm sections
 * need a Partner (requirePartner), WhatsApp opens read-only for Managers and Employees, diagnostics
 * is gated on the session alone (§7.24). The list shows a non-Partner only what they may open.
 *
 * A Partner-only section is also checked here, on the request's path: this layout renders before
 * settings/loading.tsx, so a refusal throws forbidden() before anything streams and answers with a
 * real 403 (checked only in the page, the loading skeleton would already have sent a 200). The index
 * redirects here for the same reason, so it is a real 307 rather than a streamed one. Layouts
 * stay mounted across client-side moves between sections, so the page's own check remains the one
 * that always runs, and RLS the real control. The role read never fails the layout (§0.1 rule 3):
 * when it can't be read, the full list shows and each page answers for itself.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  let section: string | null = null
  try {
    section = await requestedSection()
  } catch (err) {
    unstable_rethrow(err)
    logUnexpected(err, { source: "layout:/settings:path" })
  }
  if (section && PARTNER_SECTIONS.has(section)) await requirePartner()
  if (section === "") {
    // Same answer as settings/page.tsx: Partners land on Firm details; everyone else's settings are their profile (§4.2).
    const { user } = await requireStaff()
    redirect(user.role === "partner" ? "/settings/firm" : "/profile")
  }

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
