import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { getSession } from "@/lib/auth/current-user";
import { requireStaff, type Guarded } from "@/lib/auth/guards";
import { toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { PATH_HEADER } from "@/lib/supabase/proxy";
import { diagnosticsAccess } from "@/server/diagnostics";
import { DiagnosticsShell } from "@/components/shell/diagnostics-shell";
import { fallbackStaffShellData, loadStaffShellData, type StaffShellData } from "@/components/shell/data";
import { ShellUnavailable } from "@/components/shell/shell-unavailable";
import { StaffShell } from "@/components/shell/staff-shell";
import { TimerPanel } from "@/components/timesheet/timer-panel";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";

/**
 * The firm's app shell (§3.3). The guard runs first and only redirects: no session → /login, no
 * profile or disabled → /no-access, a Client → /portal, a temporary password → /set-password, and
 * the two-step sign-in where it applies (lib/auth/guards.ts). Everything after it degrades instead
 * of throwing, because an error in this layout can't be caught by app/(staff)/error.tsx (§0.1 rule 3).
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  // §7.24: Diagnostics must open when the database is the thing that's broken. requireStaff reads
  // profiles and would send a Partner to /no-access when that read fails, so that one page is let
  // through first, in a minimal frame, on the verified token alone.
  if (await diagnosticsWithoutProfile()) return <DiagnosticsShell>{children}</DiagnosticsShell>;

  let guarded: Guarded;
  try {
    guarded = await requireStaff();
  } catch (err) {
    unstable_rethrow(err); // redirect() signals must reach Next
    const ref = logUnexpected(err, { source: "layout:(staff):session" });
    return <ShellUnavailable errorRef={ref} area="staff" />;
  }

  const { user, supabase } = guarded;
  let data: StaffShellData;
  try {
    data = await loadStaffShellData(user, supabase);
  } catch (err) {
    // loadStaffShellData already degrades each load; this is the last line of defence (§0.1 rule 3).
    unstable_rethrow(err);
    const ref = logUnexpected(err, { source: "layout:(staff):shell-data", userId: user.id, role: user.role });
    data = fallbackStaffShellData(user, ref);
  }

  return (
    <StaffShell
      user={{ id: user.id, fullName: user.fullName, email: user.email, role: user.role }}
      firm={data.firm}
      preferences={data.preferences}
      initialCollapsed={data.initialCollapsed}
      density={data.density}
      unreadCount={data.unreadCount}
      fy={data.fy}
      warning={data.warning}
      timerPanel={<TimerPanel user={user} />}
    >
      <PresenceHeartbeat />
      {children}
    </StaffShell>
  );
}

const DIAGNOSTICS_PATH = "/settings/diagnostics";

/**
 * True only on /settings/diagnostics, when the profile can't be read (getSession reports no profile)
 * and the verified token says Partner at `aal2` (server/diagnostics.ts diagnosticsAccess). Never
 * throws: any doubt means "no", and the normal guard decides.
 */
async function diagnosticsWithoutProfile(): Promise<boolean> {
  try {
    const path = (await headers()).get(PATH_HEADER)?.split(/[?#]/)[0] ?? null;
    if (path !== DIAGNOSTICS_PATH) return false;
    const session = await getSession();
    if (session.status !== "no_profile") return false;
    const access = await diagnosticsAccess();
    if (!access.ok) return false;
    const { data } = await access.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return toAal(data?.currentLevel) === "aal2";
  } catch (err) {
    unstable_rethrow(err);
    logUnexpected(err, { source: "layout:(staff):diagnostics-gate" });
    return false;
  }
}
