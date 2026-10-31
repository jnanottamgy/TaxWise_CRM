import { NextResponse, type NextRequest } from "next/server";
import { createElement } from "react";
import { getSession } from "@/lib/auth/current-user";
import { isManagerOrPartner } from "@/lib/auth/roles";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getQuotationDocument } from "@/lib/data/quotations";
import { getFirmProfile } from "@/server/firm";
import { loadFirmLogo, pdfFileName, pdfResponseHeaders, renderPdf } from "@/server/pdf";
import { QuotationPdf } from "@/server/pdf/quotation";

/**
 * GET /api/pdf/quotation/<id>[?download=1]
 *
 * The quotation PDF (§7.5.3 layout, §11) for the firm: Partners and Managers only (quotations are
 * money, §4.1; RLS returns nothing to anyone else), at two-step sign-in (§12, the same gate as
 * server actions). Used by the quotation page's Download PDF and by Send on WhatsApp, which
 * downloads it (`?download=1`) as WhatsApp opens, to attach in the chat. Each download writes an
 * export_run audit row. Errors answer with the JSON contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let userId: string | null = null;
  try {
    const { id } = await ctx.params;
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (!isManagerOrPartner(user.role)) return json({ ok: false, error: "Quotations are prepared by Partners and Managers.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(id)) return json({ ok: false, error: "That quotation doesn't exist.", code: "not_found" }, 404);

    const firm = await getFirmProfile(supabase);
    const doc = await getQuotationDocument(supabase, id, firm.stateCode);
    if (!doc) return json({ ok: false, error: "That quotation doesn't exist, or it has been deleted.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "quotation_pdf",
      p_resource_id: id,
      p_action: "quotations.pdf",
      p_details: { quotation_number: doc.number, status: doc.status },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const logo = await loadFirmLogo(firm).catch(() => null);
    const bytes = await renderPdf(createElement(QuotationPdf, { firm, logo, doc }) as never);
    const download = request.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(pdfFileName(doc.number, "Quotation"), { download }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:quotation", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
