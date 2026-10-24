import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { getStatementDetail } from "@/lib/data/financial-statements";
import { buildFinancialStatementsWorkbook, financialStatementsFileName } from "@/server/exports/financial-statements";

/**
 * GET /api/exports/financial-statements/<id>
 *
 * The financial statements workbook (§6.13 "Export to … Excel", §7.8.3 step 6): balance sheet and
 * profit and loss in Schedule III order with last year's figures, the notes, the ageing schedules,
 * the trial balance with each ledger's line and the checks. Any staff member who can see the
 * client (RLS: Employees their own clients, §4.1), at two-step sign-in for Partners and Managers
 * (§12); an export_run audit row is written first. Errors answer with the JSON contract and a Ref.
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
    if (user.role === "client") return json({ ok: false, error: "Financial statements are prepared by the firm.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }
    if (!UUID.test(id)) return json({ ok: false, error: "That statement doesn't exist.", code: "not_found" }, 404);

    const detail = await getStatementDetail(supabase, id);
    if (!detail) return json({ ok: false, error: "That statement doesn't exist, or the client isn't one of yours.", code: "not_found" }, 404);
    if (!detail.statements) return json({ ok: false, error: "This statement has no figures yet. Upload its trial balance first.", code: "blocked" }, 409);

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "financial_statement",
      p_resource_id: id,
      p_action: "financial_statements.export_xlsx",
      p_details: { client_id: detail.row.client_id, financial_year: detail.row.financial_year, status: detail.row.status },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const { bytes } = await buildFinancialStatementsWorkbook(detail);
    const file = financialStatementsFileName(detail.client.code, detail.row.financial_year, "xlsx");
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:financial-statements", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
