import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getInvoiceDocument } from "@/lib/data/invoices";
import { getNoticeState } from "@/lib/data/portal";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { buildInvoicePdf, loadInvoiceSignatory } from "@/server/pdf/invoice";

/**
 * GET /api/portal/invoices/<id>/pdf[?download=1]
 *
 * The client portal's "PDF download" for an invoice (§7.22, §11). Portal users only, for their own
 * issued invoices: the invoice is looked up through portal_invoices / portal_invoice_items under the
 * portal user's session (getInvoiceDocument, audience "client"), so another client's invoice, a
 * draft or an invoice held for approval is simply "not found". The same gates as a server action
 * (lib/action.ts, and the compliance report route): signed in, active profile, own password set,
 * two-step sign-in verified when the person turned it on, and the privacy notice acknowledged
 * (§7.22 "before anything else"). Rendered by the invoices module's buildInvoicePdf
 * (server/pdf/invoice.tsx), the same document staff download. Each download writes a file_download
 * audit row. Errors answer with the JSON contract and a Ref (CONVENTIONS §3.5); never cached.
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
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask the firm.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role !== "client") {
      return json({ ok: false, error: "This download is for the client portal. Staff download invoices from the invoice page.", code: "forbidden" }, 403);
    }
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);

    let level: "aal1" | "aal2" | null = null;
    let enrolled = false;
    try {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      level = toAal(data?.currentLevel);
      enrolled = data?.nextLevel === "aal2";
    } catch (err) {
      log("error", "assurance level lookup failed", { source: "api:portal:invoice-pdf", userId, role: user.role, err });
    }
    if (level !== "aal2" && (mfaRequiredFor(user.role) || enrolled)) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }

    const notice = await getNoticeState(supabase, user.id);
    if (notice.required) return json({ ok: false, error: "Read and acknowledge the privacy notice first. Open your portal to see it.", code: "forbidden" }, 403);

    if (!UUID.test(id)) return json({ ok: false, error: "That invoice doesn't exist.", code: "not_found" }, 404);
    const doc = await getInvoiceDocument(supabase, id, "client");
    if (!doc) return json({ ok: false, error: "That invoice isn't in your portal. It may have been withdrawn.", code: "not_found" }, 404);

    // The signatory isn't in the portal's view; the access check above has passed.
    const signatory = await loadInvoiceSignatory(id);
    doc.signatory_id = signatory.id;
    doc.signatory_name = signatory.name;

    const firm = await getFirmProfile(supabase);
    const { bytes, fileName } = await buildInvoicePdf({ firm, doc, firmStateCode: firm.stateCode, eInvoicing: Boolean(doc.e_invoice.irn) });

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "file_download",
      p_resource_type: "invoice",
      p_resource_id: id,
      p_action: "portal.invoice_pdf",
      p_details: { invoice_number: doc.invoice_number },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) log("warn", "portal invoice download not audited", { source: "api:portal:invoice-pdf", userId, err: auditError });

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }),
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:portal:invoice-pdf", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
