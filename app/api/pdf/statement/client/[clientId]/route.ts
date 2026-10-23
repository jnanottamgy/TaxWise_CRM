import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { statementRange } from "@/lib/schemas/collections";
import { getStatementData } from "@/lib/data/collections";
import { getFirmProfile } from "@/server/firm";
import { pdfResponseHeaders } from "@/server/pdf";
import { buildStatementPdf } from "@/server/pdf/statement";

/**
 * GET /api/pdf/statement/client/<clientId>?from=YYYY-MM-DD&to=YYYY-MM-DD[&download=1]
 *
 * A client's statement of account (§7.3.3 Billing tab, §11) as a branded PDF: the opening balance,
 * every invoice, receipt, TDS deducted, credit note, write-off and reversal in the period with a
 * running balance, and the closing balance. The period defaults to the current FY so far. Partners
 * and Managers only (money, §4.1; RLS returns nothing to anyone else), at two-step sign-in (§12).
 * Each download writes an export_run audit row first (§12). Errors answer with the JSON contract and
 * a Ref (CONVENTIONS §3.5).
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
    if (user.role !== "partner" && user.role !== "manager") return json({ ok: false, error: "Statements of account are prepared by Partners and Managers.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(clientId)) return json({ ok: false, error: "That client doesn't exist.", code: "not_found" }, 404);

    const p = request.nextUrl.searchParams;
    const today = todayIST();
    const range = statementRange({ from: p.get("from"), to: p.get("to") }, today);
    if ("error" in range) return json({ ok: false, error: range.error, code: "validation" }, 400);

    const data = await getStatementData(supabase, [clientId], range.to);
    if (!data) return json({ ok: false, error: "That client isn't in your client list.", code: "not_found" }, 404);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "statement_of_account",
      p_resource_id: clientId,
      p_action: "collections.statement_client",
      p_details: { from: range.from, to: range.to },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const firm = await getFirmProfile(supabase);
    const pdf = await buildStatementPdf({ firm, kind: "client", name: data.clients[0].displayName, clients: data.clients, events: data.events, range, today, preparedBy: user.fullName });
    return new NextResponse(new Uint8Array(pdf.bytes), { status: 200, headers: pdfResponseHeaders(pdf.fileName, { download: p.get("download") === "1" }) });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:pdf:statement-client", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
