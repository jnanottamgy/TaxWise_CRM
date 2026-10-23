import type { NextRequest } from "next/server";
import { DesktopLinkBodySchema } from "@/lib/schemas/whatsapp";
import { desktopAudit, handleDesktop, refuseUnlessOk } from "@/server/desktop";
import { notify } from "@/server/notify";

/**
 * POST /api/desktop/devices/link `{ deviceKey, numberId, linked }` (docs/DESKTOP-API.md 4,
 * §7.25.7): records that a firm number was linked on this PC (linked_by = the signed-in person)
 * unless a link is already active, or ends the active link. Only a number this person may use
 * (§7.25.4: a Partner's own number only by that Partner). A new link tells every Partner
 * ("FRONTDESK-2 linked the Staff office number", §9), with how many PCs now hold that number
 * against WhatsApp's limit. Both are audited. Answers `{}`.
 */
export const dynamic = "force-dynamic";

type LinkResult = {
  status: string;
  changed?: boolean;
  linked?: boolean;
  link_id?: string | null;
  device_id?: string;
  device_name?: string;
  number_id?: string;
  number_label?: string;
  active_links?: number;
  device_limit?: number | null;
};

export async function POST(request: NextRequest) {
  return handleDesktop(request, { source: "api:desktop:link", schema: DesktopLinkBodySchema }, async (ctx) => {
    const { data, error } = await ctx.supabase.rpc("desktop_link_number", {
      p_device_key: ctx.body.deviceKey,
      p_number_id: ctx.body.numberId,
      p_linked: ctx.body.linked,
    });
    if (error) throw error;
    const r = data as unknown as LinkResult;
    refuseUnlessOk(r);
    if (!r.changed) return {};

    await desktopAudit(ctx, {
      event: "config_change",
      resourceType: "desktop_device",
      resourceId: r.device_id ?? null,
      action: ctx.body.linked ? "desktop.number_linked" : "desktop.number_unlinked",
      details: { device_name: r.device_name, number_id: r.number_id, number_label: r.number_label, active_links: r.active_links, device_limit: r.device_limit },
    });

    if (ctx.body.linked) {
      const active = r.active_links ?? 0;
      const limit = r.device_limit ?? null;
      const over = limit !== null && active > limit;
      await notify({
        to: { roles: ["partner"] },
        type: "whatsapp_device_linked",
        title: `${r.device_name} linked the ${r.number_label} number`,
        body: [
          `Linked by ${ctx.user.fullName} in TaxWise Desktop.`,
          limit !== null ? `${r.number_label} is now linked on ${active} of ${limit} PCs.` : `${r.number_label} is now linked on ${active} PCs.`,
          over ? "That is more than WhatsApp allows: remove a PC in Settings → WhatsApp → Linked PCs and from the phone's Linked devices." : null,
          "If you don't recognise this PC, remove it in Settings → WhatsApp → Linked PCs.",
        ]
          .filter(Boolean)
          .join(" "),
        linkUrl: "/settings/whatsapp#linked-pcs",
        entity: r.device_id ? { type: "desktop_device", id: r.device_id } : null,
        dedupeKey: r.link_id ? `whatsapp_device_linked:${r.link_id}` : null,
      });
    }
    return {};
  });
}
