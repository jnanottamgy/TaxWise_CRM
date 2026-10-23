import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { statementRange } from "@/lib/schemas/collections";
import { salesRegisterCsv, salesRegisterWorkbook } from "@/server/exports/sales-register";

/**
 * GET /api/exports/sales-register?from=YYYY-MM-DD&to=YYYY-MM-DD&format=xlsx|csv
 *
 * The sales register for TaxWise's own books (§7.9.8): every invoice and debit note line and every
 * credit note in the period, with the GST split per line. The period defaults to the current FY so
 * far. Partners and Managers only (§4.1), at two-step sign-in (§12); every export writes an
 * export_run audit row first. Errors answer with the JSON contract and a Ref (CONVENTIONS §3.5).
 */
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest) {
  let userId: string | null = null;
  try {
    const session = await getSession();
    if (session.status === "anonymous") return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    if (session.status !== "ok") return json({ ok: false, error: "Your access has been disabled. Ask a Partner.", code: "forbidden" }, 403);
    const { user, supabase } = session;
    userId = user.id;
    if (user.role !== "partner" && user.role !== "manager") return json({ ok: false, error: "Only Partners and Managers export the sales register.", code: "forbidden" }, 403);
    if (user.mustChangePassword) return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }

    const p = request.nextUrl.searchParams;
    const range = statementRange({ from: p.get("from"), to: p.get("to") }, todayIST());
    if ("error" in range) return json({ ok: false, error: range.error, code: "validation" }, 400);
    const format = p.get("format") === "csv" ? "csv" : "xlsx";
    const { data: firm, error: firmError } = await supabase.from("firm_settings").select("state_code").eq("id", 1).maybeSingle();
    if (firmError) throw firmError;

    const { error: auditError } = await supabase.rpc("log_audit_event", {
      p_event: "export_run",
      p_resource_type: "sales_register",
      p_resource_id: `${range.from}..${range.to}`,
      p_action: `collections.sales_register_${format}`,
      p_details: { from: range.from, to: range.to, format },
      p_success: true,
      p_error: null,
      p_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      p_user_agent: request.headers.get("user-agent"),
    });
    if (auditError) throw auditError;

    const out = format === "csv" ? await salesRegisterCsv(supabase, range, firm?.state_code ?? "29") : await salesRegisterWorkbook(supabase, range, firm?.state_code ?? "29");
    return new NextResponse(new Uint8Array(out.bytes), {
      status: 200,
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="taxwise-sales-register-${range.from}-to-${range.to}.${format}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:sales-register", userId });
    return json({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
