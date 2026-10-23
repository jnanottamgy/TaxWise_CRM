import { headers } from "next/headers"
import { redirect, unstable_rethrow } from "next/navigation"
import { requireClient, type Guarded } from "@/lib/auth/guards"
import { FIRM_DEFAULTS } from "@/lib/auth/firm-defaults"
import { logUnexpected } from "@/lib/log"
import { PATH_HEADER } from "@/lib/supabase/proxy"
import { loadPortalFrame, type PortalFrame } from "@/lib/data/portal"
import { PortalShell } from "@/components/shell/portal-shell"
import { ShellUnavailable } from "@/components/shell/shell-unavailable"

/**
 * The client portal shell (§7.22). Clients only: staff are sent to their own home, and the guard
 * handles sign-in, a temporary password (set your own first, §4.4) and disabled logins
 * (lib/auth/guards.ts). Then the privacy-notice gate (§6.10, §7.22 "acknowledge the privacy notice
 * before anything else"): while a published notice hasn't been acknowledged in its current version,
 * every portal page sends the client to /portal/welcome, whose shell shows no navigation. The portal
 * actions and the invoice PDF route refuse until then as well (server/actions/portal.ts).
 *
 * The frame is read through the portal's own windows (lib/data/portal.ts loadPortalFrame): the firm
 * through public_firm_profile (portal users can't read firm_settings) and the client's name through
 * portal_my_client (they can't read clients). If the gate check itself fails, the client is not
 * blocked. Nothing after the guard may throw (§0.1 rule 3).
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  let guarded: Guarded
  try {
    guarded = await requireClient()
  } catch (err) {
    unstable_rethrow(err)
    const ref = logUnexpected(err, { source: "layout:(portal):session" })
    return <ShellUnavailable errorRef={ref} area="portal" />
  }

  const { user, supabase } = guarded
  let frame: PortalFrame
  try {
    frame = await loadPortalFrame(supabase, user)
  } catch (err) {
    // loadPortalFrame already degrades each part; this is the last line of defence (§0.1 rule 3).
    unstable_rethrow(err)
    logUnexpected(err, { source: "layout:(portal):frame", userId: user.id, role: user.role })
    frame = { firm: { name: FIRM_DEFAULTS.firmName, logoUrl: null }, clientName: null, needsWelcome: false }
  }

  if (frame.needsWelcome) {
    let path: string | null = null
    try {
      path = (await headers()).get(PATH_HEADER)
    } catch {
      path = null
    }
    const pathname = path ? path.split(/[?#]/)[0] : null
    // Without the path we can't tell whether this already is the welcome page, so don't risk a loop.
    if (pathname && pathname !== "/portal/welcome" && !pathname.startsWith("/portal/welcome/")) {
      // Come back to where they were going (an emailed link to a request, say) once acknowledged.
      redirect(pathname === "/portal" || !path ? "/portal/welcome" : `/portal/welcome?next=${encodeURIComponent(path)}`)
    }
  }

  return (
    <PortalShell firm={frame.firm} user={{ fullName: user.fullName, email: user.email }} clientName={frame.clientName}>
      {children}
    </PortalShell>
  )
}
