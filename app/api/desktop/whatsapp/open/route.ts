import type { NextRequest } from "next/server";
import { isManagerOrPartner } from "@/lib/auth/roles";
import { chooseOpenNumber, inviteCodeFromLink } from "@/lib/domain/whatsapp";
import { getDesktopNumbers } from "@/lib/data/desktop";
import { DesktopOpenBodySchema } from "@/lib/schemas/whatsapp";
import { DesktopRefusal, handleDesktop } from "@/server/desktop";

/**
 * POST /api/desktop/whatsapp/open `{ clientId }` (docs/DESKTOP-API.md 2, §7.25.1, §7.25.5): the
 * same server check as Open chat in the CRM (record_whatsapp_open: can_open_whatsapp, only an
 * Active group, audit record_viewed on client_whatsapp_group, last_opened_at/by). Answers
 * `{ groupName, numberId, inviteCode?, clientName }`:
 *   - numberId: one of this person's context numbers — Employees the Staff office, Managers the
 *     Managers' office, Partners their own number if it is in the group, else the Managers' office;
 *   - inviteCode: only the code part of chat.whatsapp.com/<code>, only for Partners and Managers
 *     (the app keeps it in its main process and never hands it to the page).
 * Refusals: 403 forbidden (not one of your clients), 409 no_group (no Active group), 409 no_number
 * (no firm number this person may use is set up yet).
 */
export const dynamic = "force-dynamic";

const NO_NUMBER: Record<string, string> = {
  employee: "The Staff office number isn't set up for TaxWise Desktop yet. A Partner adds it in Settings → WhatsApp.",
  manager: "The Managers' office number isn't set up for TaxWise Desktop yet. A Partner adds it in Settings → WhatsApp.",
  partner: "None of the firm's WhatsApp numbers is set up for you in TaxWise Desktop yet. Add them in Settings → WhatsApp.",
};

type OpenResult = {
  status: "ok" | "forbidden" | "no_group";
  error?: string;
  client_name?: string | null;
  group?: { id: string; name: string; invite_link: string | null };
  member_number_ids?: string[];
};

export async function POST(request: NextRequest) {
  return handleDesktop(request, { source: "api:desktop:whatsapp-open", schema: DesktopOpenBodySchema }, async (ctx) => {
    const numbers = await getDesktopNumbers(ctx.supabase, ctx.user);
    if (numbers.length === 0) throw new DesktopRefusal(409, "no_number", NO_NUMBER[ctx.user.role] ?? NO_NUMBER.partner);

    const { data, error } = await ctx.supabase.rpc("record_whatsapp_open", {
      p_client_id: ctx.body.clientId,
      p_group_id: null,
      p_via: "desktop",
      p_ip: ctx.ip,
      p_user_agent: ctx.userAgent,
    });
    if (error) throw error;
    const r = data as unknown as OpenResult;
    if (r.status === "forbidden") throw new DesktopRefusal(403, "forbidden", r.error ?? "Not one of your clients.");
    if (r.status === "no_group" || !r.group) throw new DesktopRefusal(409, "no_group", r.error ?? "This client has no WhatsApp group yet.");

    const numberId = chooseOpenNumber(ctx.user.role, ctx.user.employeeId, numbers, new Set(r.member_number_ids ?? []));
    if (!numberId) throw new DesktopRefusal(409, "no_number", NO_NUMBER[ctx.user.role] ?? NO_NUMBER.partner);

    const inviteCode = isManagerOrPartner(ctx.user.role) ? inviteCodeFromLink(r.group.invite_link) : null;
    return {
      groupName: r.group.name,
      numberId,
      ...(inviteCode ? { inviteCode } : {}),
      ...(r.client_name ? { clientName: r.client_name.slice(0, 300) } : {}),
    };
  });
}
