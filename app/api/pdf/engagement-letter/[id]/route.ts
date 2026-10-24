import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getLetterDocument } from "@/lib/data/engagement-letters";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { buildEngagementLetterPdf } from "@/server/pdf/engagement-letter";

/**
 * GET /api/pdf/engagement-letter/<id>[?download=1]
 *
 * The engagement letter on the TaxWise letterhead (§7.15.3, §11): SA 210 contents for an audit, the
 * services schedule and fees for other work, signature blocks. Partners and Managers only, at
 * two-step sign-in (§4.1 "Engagement letters … Partner/Manager", §12), under RLS (engagement_letters
 * is Partner/Manager only, so anyone else gets "not found"). A draft prints marked as a draft. Each
 * download writes a file_download audit row (§12). Errors answer with the JSON contract and a Ref
 * (CONVENTIONS §3.5).
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
    if (user.role !== "partner" && user.role !== "manager") {
      return json({ ok: false, error: "Engagement letters are kept by Partners and Managers.", code: "forbidden" }, 403);
    }
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(id)) return json({ ok: false, error: "That engagement letter doesn't exist.", code: "not_found" }, 404);

    const doc = await getLetterDocument(supabase, id);
    if (!doc) return json({ ok: false, error: "That engagement letter doesn't exist, or its client is in the recycle bin.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "file_download",
      p_resource_type: "engagement_letter",
      p_resource_id: id,
      p_action: "engagement_letters.pdf",
      p_details: { client_id: doc.letter.client_id, financial_year: doc.letter.financial_year, status: doc.letter.status },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const firm = await getFirmProfile(supabase);
    const { bytes, fileName } = await buildEngagementLetterPdf({ firm, doc });
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:engagement-letter", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
