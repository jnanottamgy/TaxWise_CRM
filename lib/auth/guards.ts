import "server-only";

import { cookies, headers } from "next/headers";
import { forbidden, notFound, redirect, unstable_rethrow } from "next/navigation";
import { getSession, type CurrentUser } from "@/lib/auth/current-user";
import { homePathFor, isManagerOrPartner, type AppRole } from "@/lib/auth/roles";
import { mfaRequiredFor, toAal } from "@/lib/auth/mfa";
import type { ServerSupabase } from "@/lib/supabase/server";
import { ACTIVITY_COOKIE, PATH_HEADER, isIdleExpired, parseActivity, safeNextPath } from "@/lib/supabase/proxy";
import { log } from "@/lib/log";

/**
 * Guards for Server Components (pages and layouts), the server half of the proxy's hints.
 * Every check here reads the authority: `profiles.role` through getSession (§0.1 rule 9), the
 * verified token's assurance level (§12), and the idle-timeout cookie (§4.4).
 *
 *   const { user, supabase } = await requireUser();
 *   const { user } = await requireRole("partner", "manager");
 *   await requirePartner();
 *
 * They throw Next's redirect / not-found / forbidden signals, so never call them inside a
 * try/catch without `unstable_rethrow`. In a layout, call them before anything that can throw.
 */

export interface Guarded {
  user: CurrentUser;
  supabase: ServerSupabase;
}

export interface RequireUserOptions {
  /** Only /set-password renders for someone who still has a temporary password (§4.4). */
  allowMustChangePassword?: boolean;
  /** Only /mfa (and the password pages) render before the authenticator check (§12). */
  allowPendingMfa?: boolean;
}

async function currentPath(): Promise<string | null> {
  try {
    const h = await headers();
    return safeNextPath(h.get(PATH_HEADER));
  } catch {
    return null;
  }
}

function withNext(path: string, next: string | null): string {
  return next ? `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}` : path;
}

/**
 * Refuses a signed-in person who may not see this page: a 403 page when `experimental.authInterrupts`
 * is enabled (forbidden()), otherwise a 404 (notFound()), which also doesn't reveal the page exists.
 */
export function denyAccess(): never {
  try {
    forbidden();
  } catch (err) {
    unstable_rethrow(err); // the real 403 signal propagates; the "not enabled" error falls through
  }
  notFound();
}

/** The signed-in, active, fully verified user, or a redirect to where they need to go first. */
export async function requireUser(options: RequireUserOptions = {}): Promise<Guarded> {
  const session = await getSession();

  if (session.status === "anonymous") redirect(withNext("/login", await currentPath()));
  if (session.status === "no_profile" || session.status === "inactive") redirect("/no-access");

  const { user, supabase } = session;

  // §4.4 idle timeout: the proxy signs the session out; this catches anything it didn't see.
  const store = await cookies();
  if (isIdleExpired(parseActivity(store.get(ACTIVITY_COOKIE)?.value), Date.now(), user.role)) {
    redirect("/login?reason=idle");
  }

  if (user.mustChangePassword && !options.allowMustChangePassword) redirect("/set-password");

  if (!options.allowPendingMfa) {
    // getSession has already verified this token with the Auth server, so its `aal` is trustworthy;
    // `nextLevel` (an authenticator exists) comes from the session cookie and is only a hint, which
    // is enough for the optional case. For required roles the level alone decides.
    let currentLevel: "aal1" | "aal2" | null = null;
    let enrolled = false;
    try {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      currentLevel = toAal(data?.currentLevel);
      enrolled = data?.nextLevel === "aal2";
    } catch (err) {
      log("error", "assurance level lookup failed", { source: "guards:requireUser", userId: user.id, role: user.role, err });
    }
    if (currentLevel !== "aal2" && (mfaRequiredFor(user.role) || enrolled)) {
      redirect(withNext("/mfa", await currentPath()));
    }
  }

  return { user, supabase };
}

/** The user, if their `profiles.role` is one of `roles`; otherwise a 403/404 (see denyAccess). */
export async function requireRole(...roles: AppRole[]): Promise<Guarded> {
  const guarded = await requireUser();
  if (!roles.includes(guarded.user.role)) denyAccess();
  return guarded;
}

/** Partner, Manager or Employee. A Client is sent to their portal. */
export async function requireStaff(): Promise<Guarded> {
  const guarded = await requireUser();
  if (guarded.user.role === "client") redirect(homePathFor("client"));
  return guarded;
}

/** A portal user. Staff are sent to their own home. */
export async function requireClient(): Promise<Guarded> {
  const guarded = await requireUser();
  if (guarded.user.role !== "client") redirect(homePathFor(guarded.user.role));
  return guarded;
}

export async function requireManagerOrPartner(): Promise<Guarded> {
  const guarded = await requireStaff();
  if (!isManagerOrPartner(guarded.user.role)) denyAccess();
  return guarded;
}

export async function requirePartner(): Promise<Guarded> {
  const guarded = await requireStaff();
  if (guarded.user.role !== "partner") denyAccess();
  return guarded;
}
