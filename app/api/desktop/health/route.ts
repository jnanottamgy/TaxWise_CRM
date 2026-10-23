import type { NextRequest } from "next/server";
import { DesktopHealthBodySchema } from "@/lib/schemas/whatsapp";
import { handleDesktop, refuseUnlessOk } from "@/server/desktop";
import { notify } from "@/server/notify";

/**
 * POST /api/desktop/health `{ deviceKey, failing }` (docs/DESKTOP-API.md 5, §7.25.5): the selectors
 * client mode checks on this PC that no longer match WhatsApp Web's page. Client mode fails closed
 * there; every Partner is told (whatsapp_client_mode_down, §9) at most once a day per PC, so they
 * can turn client mode off in Settings → WhatsApp until TaxWise Desktop is updated. An empty list
 * clears the PC's failing checks. Answers `{}`.
 */
export const dynamic = "force-dynamic";

type HealthResult = { status: string; notify?: boolean; device_id?: string; device_name?: string; failing?: string[]; day?: string };

export async function POST(request: NextRequest) {
  return handleDesktop(request, { source: "api:desktop:health", schema: DesktopHealthBodySchema }, async (ctx) => {
    const { data, error } = await ctx.supabase.rpc("desktop_report_health", {
      p_device_key: ctx.body.deviceKey,
      p_failing: ctx.body.failing,
    });
    if (error) throw error;
    const r = data as unknown as HealthResult;
    refuseUnlessOk(r);
    if (r.notify && r.device_id) {
      const failing = (r.failing ?? []).slice(0, 8).join(", ");
      await notify({
        to: { roles: ["partner"] },
        type: "whatsapp_client_mode_down",
        title: `Client mode is unavailable on ${r.device_name}`,
        body: `WhatsApp changed its page, so client mode can't run on ${r.device_name}${failing ? ` (${failing})` : ""}. Employees there can't open client chats until TaxWise Desktop is updated. A Partner can turn client mode off in Settings → WhatsApp in the meantime.`,
        linkUrl: "/settings/whatsapp",
        entity: { type: "desktop_device", id: r.device_id },
        dedupeKey: `whatsapp_client_mode_down:${r.device_id}:${r.day ?? ""}`,
      });
    }
    return {};
  });
}
