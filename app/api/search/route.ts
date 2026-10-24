import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { listRecentSearches, searchEverything } from "@/lib/data/search";
import { PALETTE_ITEMS, isSearchType } from "@/lib/schemas/search";
import type { SearchResponse } from "@/components/shell/search-contract";

/**
 * GET /api/search?q=<text>[&type=<type>][&limit=<n>]
 * GET /api/search?recent=1
 *
 * Global search for the command palette (§7.18), keeping the contract in
 * components/shell/search-contract.ts:
 *   { ok: true, data: { groups: [{ type, label, items: [{ id, title, subtitle, href }], total }] } }
 * with the top 5 of each type (or `limit`, at most 10, for one `type`, e.g. a client picker), only
 * groups that matched, in the order clients, contacts, tasks, documents, people, leads, invoices,
 * quotations. search_everything (0210) runs under the caller's own session: RLS limits an Employee
 * to their own clients' records, and leads, invoices and quotations are searched for Partners and
 * Managers only (§4.1). Portal users have no search. Per-user data, so never cached (§0.1 rule 15).
 * The query itself isn't logged.
 *
 * `recent=1` answers with the caller's own recent searches instead (recent_searches, newest first,
 * RLS: own rows only), for the palette's empty state:
 *   { ok: true, data: { groups: [], recent: [{ id, query, searchedAt }] } }
 * The palette records a search with rememberSearch and forgets one with removeRecentSearch /
 * clearRecentSearches (server/actions/search-history.ts).
 */
export const dynamic = "force-dynamic";

type RecentResponse = { ok: true; data: { groups: []; recent: Array<{ id: string; query: string; searchedAt: string }> } };

function json(body: SearchResponse | RecentResponse, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest) {
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
    const { user, supabase } = session;
    userId = user.id;
    role = user.role;
    if (user.role === "client") {
      return json({ ok: false, error: "Search isn't available in the client portal.", code: "forbidden" }, 403);
    }
    if (user.mustChangePassword) {
      return json({ ok: false, error: "Set your own password first.", code: "must_change_password" }, 403);
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (toAal(aal?.currentLevel) !== "aal2" && (mfaRequiredFor(user.role) || aal?.nextLevel === "aal2")) {
      return json({ ok: false, error: "Enter the code from your authenticator app first.", code: "mfa_required" }, 403);
    }

    const p = request.nextUrl.searchParams;
    if (p.get("recent") === "1") {
      const recent = await listRecentSearches(supabase, user.id, 8);
      return json({ ok: true, data: { groups: [], recent } });
    }
    const type = p.get("type");
    const types = type && isSearchType(type) ? [type] : null;
    const requested = Number.parseInt(p.get("limit") ?? "", 10);
    const limit = types && Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 10) : PALETTE_ITEMS;

    const result = await searchEverything(supabase, user.role, p.get("q") ?? "", { limit, types });
    return json({
      ok: true,
      data: {
        groups: result.groups
          .filter((g) => g.total > 0 && g.items.length > 0)
          .map((g) => ({ type: g.type, label: g.label, total: g.total, items: g.items.map(({ id, title, subtitle, href }) => ({ id, title, subtitle, href })) })),
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "route:/api/search", userId, role });
    return json({ ok: false, error: unexpectedMessage(ref), code: "unexpected", ref }, 500);
  }
}
