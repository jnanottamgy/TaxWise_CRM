import { NextResponse, type NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getBillingSettings, getInvoiceDocument } from "@/lib/data/invoices";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { buildInvoicePdf, gatePdfRequest, loadInvoiceSignatory } from "@/server/pdf/invoice";

/**
 * GET /api/pdf/invoice/<id>[?download=1]
 *
 * The tax invoice (or debit note) as a branded PDF with every Rule 46 field (§6.4, §11). Partners
 * and Managers at two-step sign-in (§12), under RLS; a portal user only for their own issued invoice,
 * through portal_invoices (§7.22, the portal's "PDF download"); Employees never (§4.1). A draft prints
 * marked as a draft, without a number. Each staff download writes a file_download audit row (§12).
 * Errors answer with the JSON contract and a Ref (CONVENTIONS §3.5).
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
    const gate = await gatePdfRequest();
    if (!gate.ok) return json(gate.body, gate.status);
    userId = gate.userId;
    if (!UUID.test(id)) return json({ ok: false, error: "That invoice doesn't exist.", code: "not_found" }, 404);

    const doc = await getInvoiceDocument(gate.supabase, id, gate.audience);
    if (!doc) return json({ ok: false, error: "That invoice doesn't exist, or you can't see it.", code: "not_found" }, 404);
    if (gate.audience === "client") {
      // The signatory isn't in the portal's view; the access check above has passed.
      const signatory = await loadInvoiceSignatory(id);
      doc.signatory_id = signatory.id;
      doc.signatory_name = signatory.name;
    }

    if (gate.audience === "staff") {
      const { error: auditError } = await gate.supabase.rpc("log_audit_event", {
        p_event: "file_download",
        p_resource_type: "invoice",
        p_resource_id: id,
        p_action: "invoices.pdf",
        p_details: { invoice_number: doc.invoice_number, status: doc.status },
        p_success: true,
        p_error: null,
        p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        p_user_agent: request.headers.get("user-agent"),
      });
      if (auditError) throw auditError;
    }

    const [firm, settings] = await Promise.all([
      getFirmProfile(gate.supabase),
      gate.audience === "staff" ? getBillingSettings(gate.supabase) : Promise.resolve(null),
    ]);
    const { bytes, fileName } = await buildInvoicePdf({
      firm,
      doc,
      firmStateCode: settings?.firmStateCode ?? firm.stateCode,
      eInvoicing: settings ? settings.eInvoicingApplies : Boolean(doc.e_invoice.irn),
    });
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:invoice", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
