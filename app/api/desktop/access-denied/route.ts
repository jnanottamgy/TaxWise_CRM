import type { NextRequest } from "next/server";
import { DesktopAccessDeniedBodySchema } from "@/lib/schemas/whatsapp";
import { handleDesktop, refuseUnlessOk } from "@/server/desktop";

/**
 * POST /api/desktop/access-denied `{ deviceKey, numberId, chatTitle }` (docs/DESKTOP-API.md 6,
 * §7.25.5): client mode closed a chat that isn't one of this person's clients ("Not one of your
 * clients"). Writes an audit_logs row, action access_denied, on the client's group when the chat
 * title is one (resource client_whatsapp_group), otherwise on resource whatsapp_chat, with the
 * chat title, the number and the PC. The app already sends it at most once per chat per IST day.
 * Answers `{}`.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  return handleDesktop(request, { source: "api:desktop:access-denied", schema: DesktopAccessDeniedBodySchema }, async (ctx) => {
    const { data, error } = await ctx.supabase.rpc("desktop_log_access_denied", {
      p_device_key: ctx.body.deviceKey,
      p_number_id: UUID.test(ctx.body.numberId) ? ctx.body.numberId : null,
      p_chat_title: ctx.body.chatTitle,
      p_ip: ctx.ip,
      p_user_agent: ctx.userAgent,
    });
    if (error) throw error;
    refuseUnlessOk(data as { status?: string });
    return {};
  });
}
