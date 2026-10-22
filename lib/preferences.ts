/**
 * The shell's per-user preferences (§3.2 density, §3.3 sidebar and favourites, §7.1 theme), stored in
 * `profiles.preferences` (jsonb). Other keys in that column (notification channels per event, §7.17)
 * belong to other modules and are always preserved on write.
 *
 * Two cookies mirror what the server must know before the first paint: the sidebar state and the
 * density. They are display hints only, never permissions, so they are readable by the page.
 *
 * Pure and client-safe.
 */

export type ThemePreference = "light" | "dark" | "system";
export type DensityPreference = "comfortable" | "compact";

export interface ShellPreferences {
  theme: ThemePreference | null;
  density: DensityPreference;
  sidebarCollapsed: boolean | null;
  /** Starred sidebar hrefs, in the order they were starred. */
  favourites: string[];
}

export const THEME_VALUES = ["light", "dark", "system"] as const satisfies readonly ThemePreference[];
export const DENSITY_VALUES = ["comfortable", "compact"] as const satisfies readonly DensityPreference[];

/** At most this many favourites are kept. */
export const MAX_FAVOURITES = 12;

/** `collapsed` | `expanded`. Lets the server render the sidebar at the right width (§3.3). */
export const SIDEBAR_COOKIE = "tw_sidebar";
/** `compact` | `comfortable`. Lets the root layout put `density-compact` on <html> before paint (§3.2). */
export const DENSITY_COOKIE = "tw_density";
/** The class globals.css keys the compact row height on. */
export const DENSITY_COMPACT_CLASS = "density-compact";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

/** Reads the shell's keys out of `profiles.preferences`, ignoring anything malformed. */
export function parsePreferences(raw: unknown): ShellPreferences {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const favourites = Array.isArray(p.favourites)
    ? Array.from(new Set(p.favourites.filter((f): f is string => typeof f === "string" && f.startsWith("/") && f.length <= 200))).slice(
        0,
        MAX_FAVOURITES,
      )
    : [];
  return {
    theme: isOneOf(THEME_VALUES, p.theme) ? p.theme : null,
    density: isOneOf(DENSITY_VALUES, p.density) ? p.density : "comfortable",
    sidebarCollapsed: typeof p.sidebarCollapsed === "boolean" ? p.sidebarCollapsed : null,
    favourites,
  };
}

/** The sidebar cookie's value, or null when it is absent or unreadable. */
export function parseSidebarCookie(value: string | null | undefined): boolean | null {
  if (value === "collapsed") return true;
  if (value === "expanded") return false;
  return null;
}

export function parseDensityCookie(value: string | null | undefined): DensityPreference | null {
  return isOneOf(DENSITY_VALUES, value) ? value : null;
}

/** Adds or removes one favourite, keeping order and the cap. */
export function toggleFavourite(current: readonly string[], href: string, on: boolean): string[] {
  const without = current.filter((f) => f !== href);
  return on ? [...without, href].slice(-MAX_FAVOURITES) : without;
}

/**
 * Writes a display cookie from the browser. Never throws: cookies can be blocked, and the UI
 * must work without them.
 */
export function writeDisplayCookie(name: typeof SIDEBAR_COOKIE | typeof DENSITY_COOKIE, value: string): void {
  try {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax${secure}`;
  } catch {
    // Cookies unavailable: the preference still applies for this page view.
  }
}

/** Reads a cookie in the browser; null when absent or unreadable. */
export function readCookie(name: string): string | null {
  try {
    for (const part of document.cookie.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === name) return decodeURIComponent(rest.join("="));
    }
  } catch {
    // Fall through.
  }
  return null;
}
