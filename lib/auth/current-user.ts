import "server-only";

import { cache } from "react";
import { createClient, type ServerSupabase } from "@/lib/supabase/server";
import { isAppRole, type AppRole } from "@/lib/auth/roles";
import { log } from "@/lib/log";

export interface CurrentUser {
  id: string;
  email: string;
  /** From profiles.role: the authority for every server check (§0.1 rule 9). */
  role: AppRole;
  fullName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  /** employees.id for staff (Partners have one too); null for clients. */
  employeeId: string | null;
  vaultAccess: boolean;
  preferences: Record<string, unknown>;
}

export type SessionState =
  | { status: "anonymous" }
  | { status: "no_profile"; authUserId: string; email: string | null } // §4.4: "Your account isn't set up yet"
  | { status: "inactive"; authUserId: string }
  | { status: "ok"; user: CurrentUser; supabase: ServerSupabase };

/**
 * Resolves the signed-in user for this request. Memoised per request with React `cache`
 * (never across requests or users, §0.1 rule 15).
 *
 * The role comes ONLY from `profiles.role`. `user_metadata` is never consulted for permissions;
 * if it contains a `role` key we report it (audit + Partner alert, at most once per user per day)
 * through the `report_role_claim` database function, and otherwise ignore it (§4.4).
 */
export const getSession = cache(async (): Promise<SessionState> => {
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) return { status: "anonymous" };
  const authUser = authData.user;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, is_active, must_change_password, preferences")
    .eq("id", authUser.id)
    .maybeSingle();

  if (error) {
    log("error", "profile lookup failed", { source: "auth:getSession", userId: authUser.id, err: error });
  }
  if (!profile || !isAppRole(profile.role)) {
    return { status: "no_profile", authUserId: authUser.id, email: authUser.email ?? null };
  }
  if (!profile.is_active) return { status: "inactive", authUserId: authUser.id };

  if (authUser.user_metadata && Object.prototype.hasOwnProperty.call(authUser.user_metadata, "role")) {
    // Fire and forget: reporting must never block or fail the request.
    void Promise.resolve(supabase.rpc("report_role_claim")).catch(() => undefined);
  }

  let employeeId: string | null = null;
  let vaultAccess = false;
  if (profile.role !== "client") {
    const { data: emp } = await supabase
      .from("employees")
      .select("id, vault_access")
      .eq("profile_id", authUser.id)
      .maybeSingle();
    employeeId = emp?.id ?? null;
    vaultAccess = Boolean(emp?.vault_access);
  }

  return {
    status: "ok",
    supabase,
    user: {
      id: authUser.id,
      email: profile.email ?? authUser.email ?? "",
      role: profile.role,
      fullName: profile.full_name,
      isActive: profile.is_active,
      mustChangePassword: Boolean(profile.must_change_password),
      employeeId,
      vaultAccess,
      preferences: (profile.preferences as Record<string, unknown>) ?? {},
    },
  };
});

/** Convenience for pages: the signed-in user or null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const s = await getSession();
  return s.status === "ok" ? s.user : null;
}
