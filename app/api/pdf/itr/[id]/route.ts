import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { parseRuleSet } from "@/lib/domain/itr-rulesets";
import { computeStored } from "@/lib/schemas/itr";
import { getItrClientFacts, getItrComputation } from "@/lib/data/itr";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { buildItrPdf } from "@/server/pdf/itr-computation";

/**
 * GET /api/pdf/itr/<id>[?download=1]
 *
 * The ITR computation sheet (§11, §7.8.2) on letterhead, labelled AY or Tax year by statute (§6.1).
 * Any staff member who can see the client (RLS: Employees their own clients, §4.1), at two-step
 * sign-in for Partners and Managers (§12); never a portal user. The figures are recomputed here from
 * the stored inputs and the rule set they were saved with, so the PDF matches the screen and never
 * prints figures the server didn't compute. Each download writes a file_download audit row first.
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
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role === "client") return json({ ok: false, error: "Computations are prepared by the firm. Ask your contact at TaxWise for a copy.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(id)) return json({ ok: false, error: "That computation doesn't exist.", code: "not_found" }, 404);

    const detail = await getItrComputation(supabase, id);
    if (!detail) return json({ ok: false, error: "That computation doesn't exist, or isn't for one of your clients.", code: "not_found" }, 404);
    const snapshot = detail.ruleSetRaw ? parseRuleSet(detail.ruleSetRaw) : null;
    if (!detail.inputs || !snapshot?.ok) return json({ ok: false, error: "This computation's saved inputs can't be read. Open it and save it again.", code: "blocked" }, 409);
    const computed = computeStored(detail.inputs, snapshot.ruleSet);
    if (!computed.ok) return json({ ok: false, error: "This computation's inputs need correcting before it can be printed. Open it and save it again.", code: "blocked" }, 409);

    const client = await getItrClientFacts(supabase, detail.row.client_id);
    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "file_download",
      p_resource_type: "itr_computation",
      p_resource_id: id,
      p_action: "itr.pdf",
      p_details: { client_id: detail.row.client_id, financial_year: detail.row.financial_year, status: detail.row.status },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const firm = await getFirmProfile(supabase);
    const row = detail.row;
    const address = client ? [client.address, client.city, client.pincode].filter(Boolean).join(", ") || null : null;
    const { bytes, fileName } = await buildItrPdf(firm, {
      id: row.id,
      status: row.status,
      label: row.label,
      client: { name: row.client_name, legalName: client?.legal_name ?? null, code: row.client_code, pan: row.client_pan, address },
      inputs: detail.inputs,
      result: computed.result,
      regimeChosen: row.regime_chosen,
      preparedBy: row.prepared_by_name,
      reviewedBy: row.reviewed_by_name,
      reviewedAt: row.reviewed_at,
      finalisedBy: row.finalised_by_name,
      finalisedAt: row.finalised_at,
      ruleSetVerified: row.rule_set_verified,
      printedBy: user.fullName,
      printedOn: todayIST(),
    });
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: pdfResponseHeaders(fileName, { download: request.nextUrl.searchParams.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:itr", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
