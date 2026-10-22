import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { requireClient, type Guarded } from "@/lib/auth/guards";
import { logUnexpected } from "@/lib/log";
import { PATH_HEADER } from "@/lib/supabase/proxy";
import { fallbackPortalShellData, loadPortalShellData, type PortalShellData } from "@/components/shell/data";
import { PortalShell } from "@/components/shell/portal-shell";
import { ShellUnavailable } from "@/components/shell/shell-unavailable";

/**
 * The client portal shell (§7.22). Clients only: staff are sent to their own home, and the guard
 * handles sign-in, a temporary password and disabled logins (lib/auth/guards.ts). On first sign-in
 * the client goes to /portal/welcome until the privacy notice is acknowledged (§6.10); if that check
 * can't be made, the client is not blocked. Nothing after the guard may throw (§0.1 rule 3).
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  let guarded: Guarded;
  try {
    guarded = await requireClient();
  } catch (err) {
    unstable_rethrow(err);
    const ref = logUnexpected(err, { source: "layout:(portal):session" });
    return <ShellUnavailable errorRef={ref} area="portal" />;
  }

  const { user, supabase } = guarded;
  let data: PortalShellData;
  try {
    data = await loadPortalShellData(user, supabase);
  } catch (err) {
    // loadPortalShellData already degrades each load; this is the last line of defence (§0.1 rule 3).
    unstable_rethrow(err);
    logUnexpected(err, { source: "layout:(portal):shell-data", userId: user.id, role: user.role });
    data = fallbackPortalShellData();
  }

  if (data.needsWelcome) {
    let path: string | null = null;
    try {
      path = (await headers()).get(PATH_HEADER);
    } catch {
      path = null;
    }
    const pathname = path ? path.split(/[?#]/)[0] : null;
    // Without the path we can't tell whether this already is the welcome page, so don't risk a loop.
    if (pathname && pathname !== "/portal/welcome" && !pathname.startsWith("/portal/welcome/")) {
      redirect("/portal/welcome");
    }
  }

  return (
    <PortalShell firm={data.firm} user={{ fullName: user.fullName, email: user.email }} clientName={data.clientName}>
      {children}
    </PortalShell>
  );
}
