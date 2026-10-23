import { NextResponse, type NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getReceiptDocument } from "@/lib/data/receipts";
import { createAdminClient } from "@/server/admin";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { gatePdfRequest } from "@/server/pdf/invoice";
import { buildReceiptPdf } from "@/server/pdf/receipt";

/**
 * GET /api/pdf/receipt/<id>[?download=1]
 *
 * The payment receipt PDF (§7.9.4, §11). Partners and Managers at two-step sign-in (§12), under RLS;
 * a portal user for the receipts of their own invoices, through portal_payment_receipts (§7.22);
 * Employees never (§4.1). Staff downloads write a file_download audit row (§12).
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
    if (!UUID.test(id)) return json({ ok: false, error: "That receipt doesn't exist.", code: "not_found" }, 404);

    const doc = await getReceiptDocument(gate.supabase, id, gate.audience);
    if (!doc) return json({ ok: false, error: "That receipt doesn't exist, or you can't see it.", code: "not_found" }, 404);

    // Who recorded it signs for the firm; the portal view leaves that out, so read it after the check above.
    let signerName: string | null = null;
    try {
      const admin = createAdminClient();
      const { data } = await admin.from("payment_receipts").select("recorded_by, tds_section").eq("id", id).maybeSingle();
      if (data?.recorded_by) {
        const { data: p } = await admin.from("profiles").select("full_name").eq("id", data.recorded_by).maybeSingle();
        signerName = p?.full_name ?? null;
      }
      if (gate.audience === "client") doc.tds_section = data?.tds_section ?? null;
    } catch {
      signerName = null;
    }

    if (gate.audience === "staff") {
      const { error: auditError } = await gate.supabase.rpc("log_audit_event", {
        p_event: "file_download",
        p_resource_type: "payment_receipt",
        p_resource_id: id,
        p_action: "receipts.pdf",
        p_details: { receipt_number: doc.receipt_number },
        p_success: true,
        p_error: null,
        p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        p_user_agent: request.headers.get("user-agent"),
      });
      if (auditError) throw auditError;
    }

    const firm = await getFirmProfile(gate.supabase);
    const { bytes, fileName } = await buildReceiptPdf({ firm, doc, signerName });
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:receipt", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
