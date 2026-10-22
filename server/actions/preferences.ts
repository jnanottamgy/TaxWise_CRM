"use server";

import type { Json } from "@/lib/database.types";
import { cookies } from "next/headers";
import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { appEnv } from "@/lib/env";
import { FY_COOKIE, isSelectableFy } from "@/lib/fy-context";
import { isNavHref } from "@/lib/nav";
import { DENSITY_VALUES, THEME_VALUES, parsePreferences, toggleFavourite } from "@/lib/preferences";
import { ActionError, ok } from "@/lib/result";

/**
 * The shell's own state (§3.2, §3.3, §7.1): sidebar collapsed, favourites, theme, density, the FY
 * switcher, and the Inbox bell's unread count.
 *
 * Preferences live in `profiles.preferences` and are written under the user's own session (RLS).
 * These are per-user display settings, not business records, so they do not write audit rows.
 * Keys owned by other modules (notification channels, §7.17) are preserved on every write.
 */

type Patch = Record<string, unknown>;

async function mergePreferences(ctx: ActionContext, patch: (current: Record<string, unknown>) => Patch): Promise<Record<string, unknown>> {
  const { data, error } = await ctx.supabase.from("profiles").select("preferences").eq("id", ctx.user.id).single();
  throwIfDbError(error);
  const raw = data?.preferences;
  const current: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const next = { ...current, ...patch(current) };

  const { data: updated, error: updateError } = await ctx.supabase
    .from("profiles")
    .update({ preferences: next as Json })
    .eq("id", ctx.user.id)
    .select("id");
  throwIfDbError(updateError);
  if (!updated || updated.length === 0) {
    throw new ActionError("Your profile couldn't be updated, so this is remembered on this browser only.", { code: "forbidden" });
  }
  return next;
}

/** Remembers the sidebar as a 64px rail or at full width (§3.3). The browser sets the SSR cookie itself. */
export const saveSidebarCollapsed = defineAction(
  { name: "preferences.sidebar", schema: z.object({ collapsed: z.boolean() }), roles: STAFF_ROLES },
  async ({ collapsed }, ctx) => {
    await mergePreferences(ctx, () => ({ sidebarCollapsed: collapsed }));
    return ok({ collapsed });
  },
);

/** Stars or un-stars one sidebar item (§3.3). Only the role's own sidebar items can be starred. */
export const setFavourite = defineAction(
  {
    name: "preferences.favourite",
    schema: z.object({ href: z.string().min(1).max(200), on: z.boolean() }),
    roles: STAFF_ROLES,
  },
  async ({ href, on }, ctx) => {
    if (on && !isNavHref(ctx.user.role, href)) {
      throw new ActionError("Only pages in your sidebar can be added to favourites.");
    }
    const next = await mergePreferences(ctx, (current) => ({
      favourites: toggleFavourite(parsePreferences(current).favourites, href, on),
    }));
    return ok({ favourites: parsePreferences(next).favourites });
  },
);

/** Light, dark or follow the device (§3.1, §7.1). next-themes applies it; this keeps it with the profile. */
export const saveTheme = defineAction(
  { name: "preferences.theme", schema: z.object({ theme: z.enum(THEME_VALUES) }) },
  async ({ theme }, ctx) => {
    await mergePreferences(ctx, () => ({ theme }));
    return ok({ theme });
  },
);

/** Comfortable (44px rows) or compact (36px rows) (§3.2). The browser sets the SSR cookie itself. */
export const saveDensity = defineAction(
  { name: "preferences.density", schema: z.object({ density: z.enum(DENSITY_VALUES) }) },
  async ({ density }, ctx) => {
    await mergePreferences(ctx, () => ({ density }));
    return ok({ density });
  },
);

/**
 * Selects the financial year for every FY-aware screen (§3.3). Setting the cookie re-renders the
 * current page with the new year in the same round trip.
 */
export const setFinancialYear = defineAction(
  {
    name: "preferences.financial_year",
    schema: z.object({ fy: z.string().refine((v) => isSelectableFy(v), { error: "Choose a financial year from the list." }) }),
    roles: STAFF_ROLES,
  },
  async ({ fy }) => {
    const store = await cookies();
    store.set(FY_COOKIE, fy, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: appEnv() === "production" || appEnv() === "staging",
      maxAge: 60 * 60 * 24 * 365,
    });
    return ok({ fy });
  },
);

/**
 * The Inbox bell's unread count (§7.17): notifications for this user not yet read or archived.
 * The bell calls this when the window regains focus and after navigation, never on a timer, so an
 * unattended tab does not keep an idle session alive (§4.4).
 */
export const refreshUnreadCount = defineAction(
  { name: "shell.unread_count", schema: z.object({}), roles: STAFF_ROLES },
  async (_input, ctx) => {
    const { count, error } = await ctx.supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ctx.user.id)
      .is("read_at", null)
      .is("archived_at", null);
    throwIfDbError(error);
    return ok({ count: count ?? 0 });
  },
);
