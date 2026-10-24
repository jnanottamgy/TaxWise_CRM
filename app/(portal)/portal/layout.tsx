import { headers } from "next/headers"
import { notFound, redirect, unstable_rethrow } from "next/navigation"
import { requireClient, type Guarded } from "@/lib/auth/guards"
import { FIRM_DEFAULTS } from "@/lib/auth/firm-defaults"
import { logUnexpected } from "@/lib/log"
import { PATH_HEADER } from "@/lib/supabase/proxy"
import { loadPortalFrame, type PortalFrame } from "@/lib/data/portal"
import { PortalShell } from "@/components/shell/portal-shell"
import { ShellUnavailable } from "@/components/shell/shell-unavailable"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INVOICE_PATH = /^\/portal\/invoices\/([^/]+)\/?$/

/** Whether the signed-in client can see this invoice: false = 404, null = couldn't tell (let the page decide). */
async function invoiceVisible(supabase: Guarded["supabase"], segment: string, userId: string): Promise<boolean | null> {
  let id: string
  try {
    id = decodeURIComponent(segment)
  } catch {
    return false
  }
  if (!UUID.test(id)) return false
  try {
    const { data, error } = await supabase.from("portal_invoices").select("id").eq("id", id).maybeSingle()
    if (error) throw error
    return Boolean(data)
  } catch (err) {
    logUnexpected(err, { source: "layout:(portal):invoice", userId })
    return null
  }
}

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
 * blocked. Nothing after the guard may throw (§0.1 rule 3), except the 404 below.
 *
 * An invoice the client can't see (another client's, a draft, one held for approval, or no such id)
 * is answered here with a real 404: this layout renders before portal/loading.tsx, whose boundary
 * also wraps the invoice page, so the page's own notFound() would only arrive after the skeleton
 * had already been sent with a 200. The check reads portal_invoices under the client's session (the
 * same RLS window the page reads); if the read itself fails the page answers for itself.
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

  let path: string | null = null
  try {
    path = (await headers()).get(PATH_HEADER)
  } catch {
    path = null
  }
  const pathname = path ? path.split(/[?#]/)[0] : null

  if (frame.needsWelcome) {
    // Without the path we can't tell whether this already is the welcome page, so don't risk a loop.
    if (pathname && pathname !== "/portal/welcome" && !pathname.startsWith("/portal/welcome/")) {
      // Come back to where they were going (an emailed link to a request, say) once acknowledged.
      redirect(pathname === "/portal" || !path ? "/portal/welcome" : `/portal/welcome?next=${encodeURIComponent(path)}`)
    }
  }

  const invoiceId = pathname ? INVOICE_PATH.exec(pathname)?.[1] : undefined
  if (invoiceId && (await invoiceVisible(supabase, invoiceId, user.id)) === false) notFound()

  return (
    <PortalShell firm={frame.firm} user={{ fullName: user.fullName, email: user.email }} clientName={frame.clientName}>
      {children}
    </PortalShell>
  )
}
