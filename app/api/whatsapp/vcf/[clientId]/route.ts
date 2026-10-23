import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { VCARD_CONTENT_TYPE, buildVCardFile, contactCards, numbersToAdd, vcfFileName } from "@/lib/domain/whatsapp";
import { getClientWhatsApp } from "@/lib/data/whatsapp";

/**
 * GET /api/whatsapp/vcf/<clientId>?group=<groupId>&set=all|client|firm
 *
 * Step 2 of the WhatsApp group checklist (§7.25.2): the contact cards to save on the phone that
 * creates the group, because WhatsApp only adds saved contacts. One vCard 3.0 file holding the
 * firm's numbers in every client group (`TW Partner – CA Vinay`, `TW Managers' office`,
 * `TW Staff office`) and the client contacts ticked in step 3 (`XYZ Traders – Ramesh (Director)`);
 * opening it on the phone saves them in one tap. `set=client` or `set=firm` gives one half.
 *
 * Any staff member who can open the client's WhatsApp (RLS on the group, contacts and numbers),
 * at two-step sign-in for Partners and Managers (§12). Contact numbers are personal data, so each
 * download writes an export_run audit row first (§12). Errors answer with the JSON contract and a
 * Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ clientId: string }> }) {
  let userId: string | null = null;
  try {
    const { clientId } = await ctx.params;
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role === "client") return json({ ok: false, error: "WhatsApp groups are kept by the firm's staff.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(clientId)) return json({ ok: false, error: "That client doesn't exist.", code: "not_found" }, 404);

    const p = request.nextUrl.searchParams;
    const set = p.get("set") === "client" ? "client" : p.get("set") === "firm" ? "firm" : "all";
    const groupId = p.get("group");

    const data = await getClientWhatsApp(supabase, user, clientId);
    if (!data) return json({ ok: false, error: "That client isn't in your client list.", code: "not_found" }, 404);
    const group = (groupId && UUID.test(groupId) ? data.groups.find((g) => g.id === groupId) : null) ?? data.groups.find((g) => g.status !== "closed") ?? null;

    const ownerNames = new Map(data.firmNumbers.filter((n) => n.employee_id && n.owner_name).map((n) => [n.employee_id!, n.owner_name!]));
    const list = numbersToAdd({
      firmNumbers: data.firmNumbers,
      contacts: data.contacts,
      selectedContactIds: group?.checklist.contactIds ?? null,
      shortName: data.client.short_name,
      countryCode: data.settings.countryCode,
      ownerNames,
    }).filter((n) => (set === "client" ? n.kind === "client_contact" : set === "firm" ? n.kind === "firm_number" : true));

    if (list.length === 0) {
      const why =
        set === "firm"
          ? "None of the firm's WhatsApp numbers is switched on yet. A Partner adds them in Settings → WhatsApp."
          : "There are no numbers to save yet: tick the client's contacts in step 3, or add the firm's numbers in Settings → WhatsApp.";
      return json({ ok: false, error: why, code: "not_found" }, 404);
    }

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "whatsapp_contact_cards",
      p_resource_id: clientId,
      p_action: "whatsapp.contact_cards",
      p_details: { set, cards: list.length, group_id: group?.id ?? null },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const body = buildVCardFile(contactCards(list, { firmName: data.settings.firmName, clientName: data.client.short_name }));
    const name = vcfFileName(data.client.client_code, set);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": VCARD_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:whatsapp:vcf", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
