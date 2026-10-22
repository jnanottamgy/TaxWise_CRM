import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import type { SearchResponse } from "@/components/shell/search-contract";

/**
 * Global search for the command palette (§7.18). Placeholder until the search module replaces this
 * handler: it answers with no groups, so the palette shows its commands and "No results".
 *
 * The contract (components/shell/search-contract.ts):
 *   { ok: true, data: { groups: [{ type, label, items: [{ id, title, subtitle, href }], total }] } }
 * with the top 5 per type, scoped by the caller's RLS; invoices and quotations for Partners and
 * Managers only (§4.1). Per-user data, so never cached (§0.1 rule 15).
 */

function json(body: SearchResponse, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET() {
  let userId: string | null = null;
  let role: string | null = null;
  try {
    const session = await getSession();
    if (session.status === "anonymous") {
      return json({ ok: false, error: "Your session has ended. Please sign in again.", code: "unauthenticated" }, 401);
    }
    if (session.status !== "ok") {
      return json({ ok: false, error: "Your account isn't set up yet. Ask a Partner.", code: "forbidden" }, 403);
    }
    userId = session.user.id;
    role = session.user.role;
    if (session.user.role === "client") {
      return json({ ok: false, error: "Search isn't available in the client portal.", code: "forbidden" }, 403);
    }

    // The search module reads `request.nextUrl.searchParams.get("q")` here and queries the trigram indexes.
    return json({ ok: true, data: { groups: [] } });
  } catch (err) {
    const ref = logUnexpected(err, { source: "route:/api/search", userId, role });
    return json({ ok: false, error: unexpectedMessage(ref), code: "unexpected", ref }, 500);
  }
}
