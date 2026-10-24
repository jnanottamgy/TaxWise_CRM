/**
 * The contract between the command palette and `GET /api/search?q=` (§7.18). The search module owns
 * the route; the palette only relies on this shape.
 *
 *   { ok: true, data: { groups: [{ type, label, items: [{ id, title, subtitle, href }], total }] } }
 *   { ok: false, error, code?, ref? }
 *
 * `items` holds the top 5 of each type; `total` is how many matched in all (for "See all N results").
 * Results are already limited to the caller's RLS scope; invoices and quotations appear only for
 * Partners and Managers (§4.1).
 */

export type SearchResultType =
  | "client"
  | "contact"
  | "task"
  | "lead"
  | "document"
  | "employee"
  | "invoice"
  | "quotation"
  | (string & {});

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string | null;
  href: string;
}

export interface SearchResultGroup {
  type: SearchResultType;
  /** Plural, sentence case: "Clients", "Tasks". */
  label: string;
  items: SearchResultItem[];
  total: number;
}

export interface SearchResponseData {
  groups: SearchResultGroup[];
}

export type SearchResponse =
  | { ok: true; data: SearchResponseData }
  | { ok: false; error: string; code?: string; ref?: string };

/** The shortest query sent to the server. */
export const MIN_SEARCH_LENGTH = 2;

/** The full results page for a query (and optionally one type). */
export function searchPageHref(q: string, type?: string): string {
  const params = new URLSearchParams({ q });
  if (type) params.set("type", type);
  return `/search?${params.toString()}`;
}

/** Narrows an unknown JSON body to the contract; anything else reads as a failure. */
export function parseSearchResponse(body: unknown): SearchResponse {
  if (!body || typeof body !== "object") return { ok: false, error: "Search sent back something unexpected." };
  const b = body as Record<string, unknown>;
  if (b.ok === true && b.data && typeof b.data === "object" && Array.isArray((b.data as { groups?: unknown }).groups)) {
    const groups = ((b.data as { groups: unknown[] }).groups)
      .filter((g): g is SearchResultGroup => {
        if (!g || typeof g !== "object") return false;
        const x = g as Record<string, unknown>;
        return typeof x.type === "string" && typeof x.label === "string" && Array.isArray(x.items);
      })
      .map((g) => ({
        type: g.type,
        label: g.label,
        total: typeof g.total === "number" && Number.isFinite(g.total) ? g.total : g.items.length,
        items: g.items.filter(
          (i): i is SearchResultItem =>
            !!i && typeof i.id === "string" && typeof i.title === "string" && typeof i.href === "string" && i.href.startsWith("/"),
        ),
      }));
    return { ok: true, data: { groups } };
  }
  return {
    ok: false,
    error: typeof b.error === "string" ? b.error : "Search isn't available right now.",
    code: typeof b.code === "string" ? b.code : undefined,
    ref: typeof b.ref === "string" ? b.ref : undefined,
  };
}

/** One of the caller's recent searches (`GET /api/search?recent=1`, recent_searches, newest first). */
export interface RecentSearchItem {
  id: string;
  query: string;
  searchedAt: string;
}

/**
 * Narrows `GET /api/search?recent=1` ({ ok: true, data: { groups: [], recent: [...] } }) to the
 * caller's recent searches; anything else reads as none.
 */
export function parseRecentSearches(body: unknown): RecentSearchItem[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { ok?: unknown; data?: { recent?: unknown } };
  if (b.ok !== true || !b.data || !Array.isArray(b.data.recent)) return [];
  return b.data.recent.filter(
    (r): r is RecentSearchItem =>
      !!r && typeof r === "object" && typeof (r as RecentSearchItem).id === "string" && typeof (r as RecentSearchItem).query === "string" && (r as RecentSearchItem).query.trim().length > 0,
  ).map((r) => ({ id: r.id, query: r.query, searchedAt: typeof r.searchedAt === "string" ? r.searchedAt : "" }));
}

/** The ⌘K command for a client result: "Open XYZ Traders' WhatsApp", "Open Ravi Kumar's WhatsApp" (§7.25.5). */
export function whatsAppCommandLabel(clientName: string): string {
  const name = clientName.trim() || "the client";
  return `Open ${name}${/s$/i.test(name) ? "'" : "'s"} WhatsApp`;
}
