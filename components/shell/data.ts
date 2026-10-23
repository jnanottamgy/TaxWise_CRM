import "server-only";

import { cookies } from "next/headers";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { ServerSupabase } from "@/lib/supabase/server";
import { currentFy, fyOptions, getSelectedFy } from "@/lib/fy-context";
import { logUnexpected } from "@/lib/log";
import {
  DENSITY_COOKIE,
  SIDEBAR_COOKIE,
  parseDensityCookie,
  parsePreferences,
  parseSidebarCookie,
  type DensityPreference,
  type ShellPreferences,
} from "@/lib/preferences";

/**
 * What the staff shell loads for itself, under the user's own session (RLS). Nothing here may throw:
 * a layout that throws blanks the whole app (§0.1 rule 3). Every load falls back to a safe default
 * and the staff shell shows one quiet warning with a Ref. The portal frame is lib/data/portal.ts
 * loadPortalFrame (portal users can read neither clients nor firm_settings).
 */

export const DEFAULT_FIRM_NAME = "TaxWise Consultants";

/** firm_settings columns the shells read (§5.2). Explicit until lib/database.types.ts is generated. */
interface FirmBrandingRow {
  firm_name: string | null;
  logo_path: string | null;
  logo_updated_at: string | null;
}

export interface ShellFirm {
  name: string;
  logoUrl: string | null;
}

export interface StaffShellData {
  firm: ShellFirm;
  preferences: ShellPreferences;
  initialCollapsed: boolean;
  density: DensityPreference;
  unreadCount: number | null;
  fy: { selected: string; current: string; options: string[] };
  warning: { message: string; ref: string } | null;
}

type Failure = { what: string; err: unknown };

async function attempt<T>(what: string, failures: Failure[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    failures.push({ what, err });
    return null;
  }
}

/** The branding bucket is public-read for the logo only (§2.3). A changed logo gets a new URL. */
function logoUrlFor(supabase: ServerSupabase, row: FirmBrandingRow | null): string | null {
  const raw = row?.logo_path?.trim();
  if (!raw) return null;
  const path = raw.replace(/^\/+/, "").replace(/^branding\//, "");
  const { data } = supabase.storage.from("branding").getPublicUrl(path);
  if (!data?.publicUrl) return null;
  const version = row?.logo_updated_at ? Date.parse(row.logo_updated_at) : NaN;
  return Number.isFinite(version) ? `${data.publicUrl}?v=${version}` : data.publicUrl;
}

async function loadFirm(supabase: ServerSupabase, failures: Failure[]): Promise<ShellFirm> {
  const row = await attempt("firm branding", failures, async () => {
    const { data, error } = await supabase
      .from("firm_settings")
      .select("firm_name, logo_path, logo_updated_at")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    return (data as FirmBrandingRow | null) ?? null;
  });
  const name = row?.firm_name?.trim() || DEFAULT_FIRM_NAME;
  let logoUrl: string | null = null;
  try {
    logoUrl = logoUrlFor(supabase, row);
  } catch (err) {
    failures.push({ what: "firm logo", err });
  }
  return { name, logoUrl };
}

export async function loadStaffShellData(user: CurrentUser, supabase: ServerSupabase): Promise<StaffShellData> {
  const failures: Failure[] = [];
  const preferences = parsePreferences(user.preferences);

  let sidebarCookie: boolean | null = null;
  let densityCookie: DensityPreference | null = null;
  try {
    const store = await cookies();
    sidebarCookie = parseSidebarCookie(store.get(SIDEBAR_COOKIE)?.value);
    densityCookie = parseDensityCookie(store.get(DENSITY_COOKIE)?.value);
  } catch {
    // Cookies unreadable: the profile's preferences decide.
  }

  const [firm, unreadCount, selectedFy] = await Promise.all([
    loadFirm(supabase, failures),
    attempt("unread notifications", failures, async () => {
      const { count, error } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("read_at", null)
        .is("archived_at", null);
      if (error) throw error;
      return count ?? 0;
    }),
    attempt("financial year", failures, () => getSelectedFy()),
  ]);

  let fy: StaffShellData["fy"];
  try {
    const current = currentFy();
    fy = { selected: selectedFy ?? current, current, options: fyOptions() };
  } catch (err) {
    failures.push({ what: "financial years", err });
    fy = { selected: "", current: "", options: [] };
  }

  let warning: StaffShellData["warning"] = null;
  if (failures.length > 0) {
    const ref = logUnexpected(failures[0].err, {
      source: "layout:(staff)",
      userId: user.id,
      role: user.role,
      failed: failures.map((f) => f.what),
    });
    warning = { message: "Some details in the sidebar didn't load, so counts may be out of date.", ref };
  }

  return {
    firm,
    preferences,
    initialCollapsed: sidebarCookie ?? preferences.sidebarCollapsed ?? false,
    density: densityCookie ?? preferences.density,
    unreadCount,
    fy,
    warning,
  };
}

/**
 * The staff shell with nothing loaded: the firm's default name, the profile's own preferences, no
 * unread count and the current FY. Used only if loadStaffShellData itself fails unexpectedly.
 */
export function fallbackStaffShellData(user: CurrentUser, ref: string): StaffShellData {
  let preferences: ShellPreferences;
  try {
    preferences = parsePreferences(user.preferences);
  } catch {
    preferences = parsePreferences(null);
  }
  let fy: StaffShellData["fy"] = { selected: "", current: "", options: [] };
  try {
    const current = currentFy();
    fy = { selected: current, current, options: fyOptions() };
  } catch {
    // The switcher shows nothing to choose; FY-aware pages fall back to the current year themselves.
  }
  return {
    firm: { name: DEFAULT_FIRM_NAME, logoUrl: null },
    preferences,
    initialCollapsed: preferences.sidebarCollapsed ?? false,
    density: preferences.density,
    unreadCount: null,
    fy,
    warning: { message: "Some details in the sidebar didn't load, so counts may be out of date.", ref },
  };
}

