import type { NextRequest } from "next/server";
import { getDesktopContextData } from "@/lib/data/desktop";
import { handleDesktop, refuseUnlessOk } from "@/server/desktop";

/**
 * GET /api/desktop/context (docs/DESKTOP-API.md 1, §7.25.1): who is signed in, client mode and
 * Employee notifications (Settings → WhatsApp), the firm numbers this person may use (§7.25.4: a
 * Partner's own number only to that Partner) and, for Employees, the groups they may open (covers
 * in force included; never null for an Employee). Partners and Managers get allowedGroups null
 * (all). Also stamps the PC's last user and last seen. Revoked PCs are refused first
 * (server/desktop.ts); a portal user gets 403 forbidden.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleDesktop(request, { source: "api:desktop:context", schema: null }, async (ctx) => {
    const touched = await ctx.supabase.rpc("desktop_touch_device", { p_device_key: ctx.deviceKey });
    if (touched.error) throw touched.error;
    const status = (touched.data as { status?: string } | null)?.status;
    // A PC that hasn't checked in yet still gets its context; the app checks in after sign-in.
    if (status !== "not_found") refuseUnlessOk(touched.data as { status?: string });

    const data = await getDesktopContextData(ctx.supabase, ctx.user);
    const name = (ctx.user.fullName || ctx.user.email || "TaxWise user").slice(0, 200);
    return {
      user: { id: ctx.user.id, employeeId: ctx.user.employeeId, name, role: ctx.user.role },
      clientMode: data.clientMode,
      employeeNotifications: data.employeeNotifications,
      numbers: data.numbers,
      allowedGroups: data.allowedGroups,
    };
  });
}
