import { headers } from "next/headers"
import { unstable_rethrow } from "next/navigation"
import { requireManagerOrPartner } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { PATH_HEADER } from "@/lib/supabase/proxy"

/**
 * Client groups (§7.4) and Add client (§7.3.2) are for Partners and Managers (§4.1); the clients
 * list and Client 360 are for every staff role, so this layout checks only those two, on the path
 * the proxy forwards.
 *
 * The check runs here because this layout renders before clients/loading.tsx, whose boundary also
 * wraps the nested groups and new segments: a refusal throws forbidden() before anything streams, so
 * it answers with a real 403 (checked only in the page, the loading skeleton would already have sent
 * a 200). Layouts stay mounted across client-side moves, so the pages' own checks remain the ones
 * that always run, and RLS the real control. Reading the path never fails the layout (§0.1 rule 3).
 */
const MANAGER_OR_PARTNER = /^\/clients\/(groups|new)(\/|$)/

export default async function ClientsLayout({ children }: { children: React.ReactNode }) {
  let path: string | null = null
  try {
    path = (await headers()).get(PATH_HEADER)?.split(/[?#]/)[0] ?? null
  } catch (err) {
    unstable_rethrow(err)
    logUnexpected(err, { source: "layout:/clients:path" })
  }
  if (path && MANAGER_OR_PARTNER.test(path)) await requireManagerOrPartner()
  return children
}
