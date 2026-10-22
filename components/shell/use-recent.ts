"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { readLocal, useLocalStorageJSON } from "@/hooks/use-local-storage";

/**
 * Per-user, per-browser memory for the shell: the last places visited (sidebar "Recent", §3.3) and
 * the last searches (command palette, §7.18). localStorage only, every access guarded (it can be
 * blocked); nothing sensitive is stored beyond page titles the user has already seen.
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

/** Recent searches for the command palette, newest first. */
export function useRecentSearches(userId: string): {
  searches: string[];
  remember: (q: string) => void;
  clear: () => void;
} {
  const [stored, setStored] = useLocalStorageJSON<unknown>(`tw:recent-searches:${userId}`, []);
  const searches = React.useMemo(
    () => (Array.isArray(stored) ? stored.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, MAX_SEARCHES) : []),
    [stored],
  );
  const remember = React.useCallback(
    (q: string) => {
      const query = q.trim().slice(0, 120);
      if (!query) return;
      setStored([query, ...searches.filter((s) => s.toLowerCase() !== query.toLowerCase())].slice(0, MAX_SEARCHES));
    },
    [searches, setStored],
  );
  const clear = React.useCallback(() => setStored(null), [setStored]);
  return { searches, remember, clear };
}
