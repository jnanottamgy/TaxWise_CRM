import { NextResponse, type NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getCreditNoteDocument } from "@/lib/data/credit-notes";
import { createAdminClient } from "@/server/admin";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { gatePdfRequest } from "@/server/pdf/invoice";
import { buildCreditNotePdf } from "@/server/pdf/credit-note";

/**
 * GET /api/pdf/credit-note/<id>[?download=1]
 *
 * The credit note PDF (§7.9.7, §11). Partners and Managers at two-step sign-in (§12), under RLS; a
 * portal user for the credit notes on their own invoices, through portal_credit_notes (§7.22);
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
    if (!UUID.test(id)) return json({ ok: false, error: "That credit note doesn't exist.", code: "not_found" }, 404);

    const doc = await getCreditNoteDocument(gate.supabase, id, gate.audience);
    if (!doc) return json({ ok: false, error: "That credit note doesn't exist, or you can't see it.", code: "not_found" }, 404);

    // The issuing Partner signs; the portal view leaves that out, so read it after the check above.
    let signerName: string | null = null;
    try {
      const admin = createAdminClient();
      const { data } = await admin.from("credit_notes").select("issued_by, reason_code").eq("id", id).maybeSingle();
      if (data?.issued_by) {
        const { data: p } = await admin.from("profiles").select("full_name").eq("id", data.issued_by).maybeSingle();
        signerName = p?.full_name ?? null;
      }
      if (gate.audience === "client") doc.reason_code = data?.reason_code ?? null;
    } catch {
      signerName = null;
    }

    if (gate.audience === "staff") {
      const { error: auditError } = await gate.supabase.rpc("log_audit_event", {
        p_event: "file_download",
        p_resource_type: "credit_note",
        p_resource_id: id,
        p_action: "credit_notes.pdf",
        p_details: { credit_note_number: doc.credit_note_number },
        p_success: true,
        p_error: null,
        p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        p_user_agent: request.headers.get("user-agent"),
      });
      if (auditError) throw auditError;
    }

    const firm = await getFirmProfile(gate.supabase);
    const { bytes, fileName } = await buildCreditNotePdf({ firm, doc, signerName });
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:credit-note", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
