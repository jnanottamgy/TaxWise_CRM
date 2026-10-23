import type { NextRequest } from "next/server";
import { DesktopCheckinBodySchema } from "@/lib/schemas/whatsapp";
import { handleDesktop, refuseUnlessOk } from "@/server/desktop";

/**
 * POST /api/desktop/devices/checkin `{ deviceKey, deviceName, os, appVersion }`
 * (docs/DESKTOP-API.md 3, §7.25.3 start-up): creates or updates the PC in desktop_devices (last
 * user, last seen; a Partner's rename is kept) and answers `{ deviceId }`. A removed PC is refused
 * with 403 device_revoked, before the session check (server/desktop.ts) and again in the database.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleDesktop(request, { source: "api:desktop:checkin", schema: DesktopCheckinBodySchema }, async (ctx) => {
    const { data, error } = await ctx.supabase.rpc("desktop_checkin", {
      p_device_key: ctx.body.deviceKey,
      p_device_name: ctx.body.deviceName,
      p_os: ctx.body.os,
      p_app_version: ctx.body.appVersion ?? ctx.appVersion,
    });
    if (error) throw error;
    const r = data as { status?: string; device_id?: string } | null;
    refuseUnlessOk(r);
    return { deviceId: r!.device_id };
  });
}
