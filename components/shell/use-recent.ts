"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { readLocal, useLocalStorageJSON, writeLocal } from "@/hooks/use-local-storage";
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH, normaliseQuery } from "@/lib/schemas/search";
import { clearRecentSearches, rememberSearch, removeRecentSearch } from "@/server/actions/search-history";
import { parseRecentSearches, type RecentSearchItem } from "./search-contract";

/**
 * Per-user memory for the shell: the last places visited (sidebar "Recent", §3.3), kept in this
 * browser's localStorage (every access guarded, it can be blocked; nothing beyond page titles the
 * user has already seen), and the last searches (command palette, §7.18), kept per person on the
 * server.
 */

export interface RecentPlace {
  href: string;
  title: string;
  at: number;
}

const MAX_PLACES = 6; // the current page plus the last 5
const MAX_SEARCHES = 8;
const TITLE_SUFFIX = / · TaxWise$/;

/** Paths that are not "places": the root redirect and the search page itself. */
function isPlace(pathname: string): boolean {
  return pathname !== "/" && !pathname.startsWith("/search");
}

function sanitisePlaces(value: unknown): RecentPlace[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (p): p is RecentPlace =>
        !!p && typeof p === "object" && typeof p.href === "string" && p.href.startsWith("/") && typeof p.title === "string" && typeof p.at === "number",
    )
    .slice(0, MAX_PLACES);
}

function pageTitle(fallback: string): string {
  try {
    const t = document.title.replace(TITLE_SUFFIX, "").trim();
    return t && t !== "TaxWise Consultants" ? t : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The last places this user visited, newest first, excluding the page being shown. Records the
 * current page on every navigation and picks up its title once the page's metadata lands.
 */
export function useRecentPlaces(userId: string, labelFor: (pathname: string) => string | null): RecentPlace[] {
  const pathname = usePathname();
  const key = `tw:recent-places:${userId}`;
  const [stored, setStored] = useLocalStorageJSON<unknown>(key, []);
  const places = React.useMemo(() => sanitisePlaces(stored), [stored]);

  React.useEffect(() => {
    if (!pathname || !isPlace(pathname)) return;
    const fallback = labelFor(pathname) ?? pathname;

    const record = (title: string) => {
      // Read the stored list afresh: during hydration the rendered value is still the empty fallback.
      const raw = readLocal(key);
      let current: RecentPlace[] = [];
      try {
        current = raw ? sanitisePlaces(JSON.parse(raw)) : [];
      } catch {
        current = [];
      }
      const rest = current.filter((p) => p.href !== pathname);
      setStored([{ href: pathname, title, at: Date.now() }, ...rest].slice(0, MAX_PLACES));
    };

    // Sidebar pages have a known name; detail pages take the document title once it updates.
    const known = labelFor(pathname);
    if (known) {
      record(known);
      return;
    }
    let lastTitle = "";
    const sync = () => {
      const title = pageTitle(fallback);
      if (title !== lastTitle) {
        lastTitle = title;
        record(title);
      }
    };
    const timer = window.setTimeout(sync, 400);
    let observer: MutationObserver | null = null;
    try {
      observer = new MutationObserver(sync);
      observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    } catch {
      observer = null;
    }
    const stop = window.setTimeout(() => observer?.disconnect(), 4000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(stop);
      observer?.disconnect();
    };
  }, [pathname, key, labelFor, setStored]);

  return React.useMemo(() => places.filter((p) => p.href !== pathname).slice(0, 5), [places, pathname]);
}

/**
 * Recent searches for the command palette, newest first (§7.18 "per user": the recent_searches
 * table, not this browser). Loaded from `GET /api/search?recent=1` when the palette opens; a search
 * is remembered with rememberSearch, one is forgotten with removeRecentSearch and the list is
 * emptied with clearRecentSearches (server/actions/search-history.ts). The list updates at once and
 * is reloaded from the server after each change, so a failed save shows the stored list again.
 * Searches kept in this browser by earlier versions are removed.
 */
export function useRecentSearches(userId: string): {
  searches: RecentSearchItem[];
  remember: (q: string) => void;
  forget: (id: string) => void;
  clear: () => void;
} {
  const [searches, setSearches] = React.useState<RecentSearchItem[]>([]);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    if (readLocal(`tw:recent-searches:${userId}`) !== null) writeLocal(`tw:recent-searches:${userId}`, null);
  }, [userId]);

  React.useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/search?recent=1", { signal: controller.signal, headers: { accept: "application/json" }, cache: "no-store" });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (!controller.signal.aborted) setSearches(parseRecentSearches(body).slice(0, MAX_SEARCHES));
      } catch {
        // No recent searches is a fine empty state; the palette still searches.
      }
    })();
    return () => controller.abort();
  }, [userId, version]);

  const reload = React.useCallback(() => setVersion((v) => v + 1), []);

  const remember = React.useCallback(
    (q: string) => {
      const query = normaliseQuery(q).slice(0, SEARCH_MAX_LENGTH);
      if (query.length < SEARCH_MIN_LENGTH) return;
      setSearches((list) => [{ id: `pending:${query}`, query, searchedAt: new Date().toISOString() }, ...list.filter((s) => s.query.toLowerCase() !== query.toLowerCase())].slice(0, MAX_SEARCHES));
      void rememberSearch({ query }).catch(() => undefined);
    },
    [],
  );
  const forget = React.useCallback(
    (id: string) => {
      setSearches((list) => list.filter((s) => s.id !== id));
      if (id.startsWith("pending:")) return;
      void removeRecentSearch({ id })
        .then((r) => {
          if (!r.ok) reload();
        })
        .catch(reload);
    },
    [reload],
  );
  const clear = React.useCallback(() => {
    setSearches([]);
    void clearRecentSearches({})
      .then((r) => {
        if (!r.ok) reload();
      })
      .catch(reload);
  }, [reload]);
  return { searches, remember, forget, clear };
}
