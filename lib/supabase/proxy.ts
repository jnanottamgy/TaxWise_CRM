/**
 * Session refresh and route guard for `proxy.ts` (§0.1 rule 9, §4.4, §12).
 *
 * The proxy is a redirect layer, not a permission check. It reads `app_metadata.role` (writable only
 * by the service role) as a HINT for where to send people; it never reads `user_metadata`, and a
 * missing role means no access, with no fallback. Pages (lib/auth/guards.ts) and actions
 * (lib/action.ts) re-check everything against `profiles.role`; RLS is the real control.
 *
 * Kept fast: no database queries. The only network call is Supabase's own session refresh/verify
 * (getClaims), plus a sign-out when an idle session has to be revoked.
 *
 * Everything above `updateSession` is pure and unit-tested (tests/unit/proxy-routing.test.ts).
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";
import { homePathFor, isAppRole, type AppRole } from "@/lib/auth/roles";
import { mfaRequiredFor, toAal, type Aal } from "@/lib/auth/mfa";

// -------------------------------------------------------------------------------------------------
// Constants shared with the auth actions and page guards
// -------------------------------------------------------------------------------------------------

/** Last-activity cookie for the idle timeout (§4.4). Value: epoch milliseconds. */
export const ACTIVITY_COOKIE = "tw_last_active";
/** Request header the proxy sets so Server Components know the path being rendered. */
export const PATH_HEADER = "x-tw-path";

export const IDLE_LIMIT_MS = {
  staff: 12 * 60 * 60 * 1000, // 12 hours
  client: 2 * 60 * 60 * 1000, // 2 hours
} as const;

/** Don't rewrite the activity cookie more often than this. */
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;

/** Options for the activity cookie (§12: HttpOnly, Secure, SameSite=Lax). */
export function activityCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 };
}

/**
 * Supabase auth cookie options (§12). HttpOnly is safe because every auth flow in this app (sign-in,
 * password, MFA, sign-out) runs on the server; the browser client is not used for auth.
 */
export function authCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: "lax", path: "/" };
}

// -------------------------------------------------------------------------------------------------
// Path classes
// -------------------------------------------------------------------------------------------------

const PUBLIC_EXACT = new Set(["/login", "/forgot-password", "/reset-password", "/setup", "/auth/confirm", "/api/health"]);
/**
 * /q/ and /api/q/: the public quotation page and its PDF (token-checked, rate-limited, §7.23).
 * /api/desktop/: TaxWise Desktop's API answers for itself (server/desktop.ts): a removed PC gets 403
 * device_revoked even with nobody signed in, then the session check (401, never a redirect) and the
 * two-step gate. Not a machine prefix, so its session cookies still refresh here.
 */
const PUBLIC_PREFIXES = ["/q/", "/api/q/", "/api/desktop/", "/api/cron/", "/api/webhooks/"];
/** Machine endpoints: no cookies to refresh, skip Supabase entirely. */
const MACHINE_PREFIXES = ["/api/health", "/api/cron/", "/api/webhooks/"];
const STATIC_FILE = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|css|js|map|txt|xml|webmanifest)$/i;

/** Pages a signed-in person may need while they are still being let in. */
export const GATE_PATHS = ["/no-access", "/set-password", "/mfa"] as const;

/** Auth pages that make no sense as a destination after signing in. */
const NOT_A_DESTINATION = new Set(["/login", "/forgot-password", "/reset-password", "/setup", "/auth/confirm", "/no-access", "/set-password", "/mfa"]);

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith("/_next/") || pathname === "/favicon.ico" || STATIC_FILE.test(pathname);
}

/**
 * Development-only pages under /dev (the UI kit gallery at /dev/kit). Outside production they open
 * without a session; in production the proxy treats them like any other page and the pages
 * themselves answer 404.
 */
export function isDevToolPath(pathname: string, appEnv: string | undefined = process.env.APP_ENV): boolean {
  return appEnv !== "production" && under(pathname, "/dev");
}

/** Paths anyone may open without a session (§4.4 task brief). */
export function isPublicPath(pathname: string): boolean {
  if (isStaticAsset(pathname)) return true;
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (isDevToolPath(pathname)) return true;
  if (pathname === "/q") return false;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isMachinePath(pathname: string): boolean {
  return MACHINE_PREFIXES.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : under(pathname, p)));
}

export function isApiPath(pathname: string): boolean {
  return under(pathname, "/api");
}

export function isPortalPath(pathname: string): boolean {
  return under(pathname, "/portal");
}

export function isGatePath(pathname: string): boolean {
  return GATE_PATHS.some((p) => under(pathname, p));
}

/** The firm's app: everything that is not public, the portal, an API, a gate page or the root. */
export function isStaffPath(pathname: string): boolean {
  return pathname !== "/" && !isPublicPath(pathname) && !isPortalPath(pathname) && !isApiPath(pathname) && !isGatePath(pathname);
}

/** Can this role land on this path? Clients only in the portal; staff never in the portal. */
export function pathAllowedForRole(pathname: string, role: AppRole): boolean {
  if (role === "client") return isPortalPath(pathname);
  return isStaffPath(pathname);
}

/**
 * A same-origin path to continue to, or `fallback`. Refuses absolute URLs, protocol-relative
 * `//host`, back-slash tricks, control characters and auth pages (no loops through /login).
 */
export function safeNextPath(raw: string | null | undefined, fallback: string | null = null): string | null {
  if (!raw || typeof raw !== "string" || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, "http://taxwise.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://taxwise.invalid") return fallback;
  if (NOT_A_DESTINATION.has(url.pathname) || isApiPath(url.pathname) || isStaticAsset(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where to send someone after sign-in: `next` when it suits their role, else their home (§4.4). */
export function destinationFor(role: AppRole, next: string | null | undefined): string {
  const safe = safeNextPath(next);
  if (safe) {
    const pathname = safe.split(/[?#]/)[0];
    if (pathAllowedForRole(pathname, role)) return safe;
  }
  return homePathFor(role);
}

// -------------------------------------------------------------------------------------------------
// Idle timeout (§4.4): 12 hours for staff, 2 hours for clients
// -------------------------------------------------------------------------------------------------

export function idleLimitFor(role: string | null | undefined): number {
  return role === "client" ? IDLE_LIMIT_MS.client : IDLE_LIMIT_MS.staff;
}

export function parseActivity(value: string | null | undefined): number | null {
  if (!value || !/^[0-9]{10,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** True when the last activity is older than the role's idle limit. No cookie = not expired. */
export function isIdleExpired(lastActive: number | null, now: number, role: string | null | undefined): boolean {
  if (lastActive === null) return false;
  return now - lastActive > idleLimitFor(role);
}

/**
 * Requests that are not a person doing something: presence heartbeats and the desktop app's
 * five-minute context refresh (§7.12, §7.25). They must not keep an idle session alive.
 */
export function countsAsActivity(pathname: string): boolean {
  return !isApiPath(pathname);
}

// -------------------------------------------------------------------------------------------------
// The decision
// -------------------------------------------------------------------------------------------------

export interface SessionHint {
  /** app_metadata.role from the verified JWT, if it is a known role. Never user_metadata. */
  role: AppRole | null;
  /** app_metadata.must_change_password. */
  mustChangePassword: boolean;
  /** This session's assurance level (from the verified JWT). */
  aal: Aal | null;
  /** The person has a verified authenticator (hint from the session cookie). */
  mfaEnrolled: boolean;
}

export interface RouteInput {
  pathname: string;
  /** Including the leading "?", or "". */
  search: string;
  /** A Server Action POST (has the `next-action` header). */
  isServerAction: boolean;
  session: SessionHint | null;
  idleExpired: boolean;
}

export type RouteDecision =
  | { kind: "next"; signOut?: boolean }
  | { kind: "redirect"; to: string; signOut?: boolean }
  | { kind: "json"; status: 401 | 403; code: string; error: string; signOut?: boolean };

const SESSION_ENDED = "Your session has ended. Please sign in again.";

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

function loginRedirect(input: RouteInput, reason?: string): RouteDecision {
  const here = `${input.pathname}${input.search}`;
  const next = input.pathname === "/" ? null : safeNextPath(here);
  return { kind: "redirect", to: withQuery("/login", { next, reason }) };
}

function needsMfa(s: SessionHint): boolean {
  if (s.aal === "aal2") return false;
  return mfaRequiredFor(s.role) || s.mfaEnrolled;
}

/**
 * Decides what the proxy does with one request. Order matters:
 * idle sign-out → public paths → no session → no role → forced password change → two-step
 * sign-in → client/staff areas.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const { pathname, isServerAction } = input;
  const api = isApiPath(pathname);
  let session = input.session;
  let signOut = false;

  if (session && input.idleExpired) {
    signOut = true;
    session = null;
    if (pathname === "/login" && !isServerAction) {
      return input.search.includes("reason=idle")
        ? { kind: "next", signOut }
        : { kind: "redirect", to: withQuery("/login", { reason: "idle" }), signOut };
    }
    if (!isPublicPath(pathname)) {
      if (api) return { kind: "json", status: 401, code: "unauthenticated", error: SESSION_ENDED, signOut };
      if (isServerAction) return { kind: "next", signOut }; // the action answers "session ended"
      return { ...loginRedirect(input, "idle"), signOut };
    }
    return { kind: "next", signOut };
  }

  if (isPublicPath(pathname)) {
    // A signed-in person opening the sign-in page goes straight to where they belong.
    if (pathname === "/login" && session?.role && !isServerAction) {
      const next = new URLSearchParams(input.search).get("next");
      return { kind: "redirect", to: destinationFor(session.role, next) };
    }
    return { kind: "next" };
  }

  if (!session) {
    if (api) return { kind: "json", status: 401, code: "unauthenticated", error: SESSION_ENDED };
    if (isServerAction) return { kind: "next" };
    return loginRedirect(input);
  }

  // §0.1 rule 9: no app_metadata.role, no access. No fallback.
  if (!session.role) {
    if (under(pathname, "/no-access") || isServerAction) return { kind: "next" };
    if (api) return { kind: "json", status: 403, code: "forbidden", error: "Your account isn't set up yet. Ask a Partner." };
    return { kind: "redirect", to: "/no-access" };
  }

  // §4.4: until a temporary password is changed, everything except /set-password redirects there.
  if (session.mustChangePassword) {
    if (under(pathname, "/set-password") || under(pathname, "/no-access") || isServerAction) return { kind: "next" };
    if (api) return { kind: "json", status: 403, code: "must_change_password", error: "Set your own password first." };
    return { kind: "redirect", to: "/set-password" };
  }

  // §12: Partners and Managers (and anyone who turned it on) verify with their authenticator app.
  if (needsMfa(session)) {
    if (isGatePath(pathname)) return { kind: "next" };
    if (api || isServerAction) {
      return { kind: "json", status: 403, code: "mfa_required", error: "Enter the code from your authenticator app first." };
    }
    const next = pathname === "/" ? homePathFor(session.role) : safeNextPath(`${pathname}${input.search}`);
    return { kind: "redirect", to: withQuery("/mfa", { next }) };
  }

  if (api || isServerAction || isGatePath(pathname)) return { kind: "next" };
  if (pathname === "/") return { kind: "redirect", to: homePathFor(session.role) };

  if (session.role === "client" && !isPortalPath(pathname)) return { kind: "redirect", to: homePathFor("client") };
  if (session.role !== "client" && isPortalPath(pathname)) return { kind: "redirect", to: homePathFor(session.role) };

  return { kind: "next" };
}

// -------------------------------------------------------------------------------------------------
// The proxy body
// -------------------------------------------------------------------------------------------------

function isSecure(request: NextRequest): boolean {
  return request.nextUrl.protocol === "https:";
}

/** Copies the session cookies and no-cache headers Supabase set on `from` onto `to`. */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  for (const h of ["cache-control", "expires", "pragma"]) {
    const v = from.headers.get(h);
    if (v) to.headers.set(h, v);
  }
  return to;
}

function finish(request: NextRequest, response: NextResponse): NextResponse {
  // §12: every response is noindex except the sign-in page.
  if (request.nextUrl.pathname !== "/login") response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const secure = isSecure(request);

  // Server Components read this to build "?next=" links (lib/auth/guards.ts). Always overwritten,
  // so a client can't inject its own value.
  request.headers.set(PATH_HEADER, `${pathname}${search}`);

  if (isMachinePath(pathname) || isStaticAsset(pathname)) {
    return finish(request, NextResponse.next({ request }));
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Misconfigured deployment: let pages render their own "not configured" errors instead of looping.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "supabase env missing", source: "proxy" }));
    return finish(request, NextResponse.next({ request }));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(url, anonKey, {
    cookieOptions: authCookieOptions(secure),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  // Nothing may run between createServerClient and getClaims (Supabase SSR guidance): this call
  // verifies the JWT and refreshes an expired session, writing the new cookies through setAll.
  let session: SessionHint | null = null;
  try {
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (claims?.sub) {
      const appMeta = (claims.app_metadata ?? {}) as Record<string, unknown>;
      const role = isAppRole(appMeta.role) ? appMeta.role : null;
      let mfaEnrolled = false;
      const aal = toAal(claims.aal);
      if (aal !== "aal2") {
        const { data: levels } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        mfaEnrolled = levels?.nextLevel === "aal2";
      }
      session = { role, mustChangePassword: appMeta.must_change_password === true, aal, mfaEnrolled };
    }
  } catch (err) {
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "session refresh failed", source: "proxy", err: err instanceof Error ? err.message : String(err) }),
    );
    session = null;
  }

  const now = Date.now();
  const lastActive = parseActivity(request.cookies.get(ACTIVITY_COOKIE)?.value);
  const idleExpired = session !== null && isIdleExpired(lastActive, now, session.role);

  const decision = decideRoute({
    pathname,
    search,
    isServerAction: request.method === "POST" && request.headers.has("next-action"),
    session,
    idleExpired,
  });

  if (decision.signOut) {
    try {
      await supabase.auth.signOut({ scope: "local" }); // revokes this session's refresh token
    } catch {
      // Fall through: the cookies are cleared below either way.
    }
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith("sb-")) {
        request.cookies.delete(c.name);
        response.cookies.set(c.name, "", { ...authCookieOptions(secure), maxAge: 0 });
      }
    }
    request.cookies.delete(ACTIVITY_COOKIE);
    if (decision.kind === "next") {
      // Forward the cleared cookies so the page or action sees a signed-out request.
      response = carryCookies(response, NextResponse.next({ request }));
    }
  }

  let out: NextResponse;
  if (decision.kind === "redirect") {
    out = carryCookies(response, NextResponse.redirect(new URL(decision.to, request.url)));
  } else if (decision.kind === "json") {
    out = carryCookies(
      response,
      NextResponse.json({ ok: false, error: decision.error, code: decision.code }, { status: decision.status }),
    );
    out.headers.set("Cache-Control", "no-store");
  } else {
    out = response;
  }

  // Activity cookie: cleared on sign-out or with no session; refreshed (at most once a minute) on
  // requests that are a person doing something.
  if (decision.signOut || !session) {
    if (request.cookies.has(ACTIVITY_COOKIE) || decision.signOut) {
      out.cookies.set(ACTIVITY_COOKIE, "", { ...activityCookieOptions(secure), maxAge: 0 });
    }
  } else if (countsAsActivity(pathname) && (lastActive === null || now - lastActive > ACTIVITY_WRITE_INTERVAL_MS)) {
    out.cookies.set(ACTIVITY_COOKIE, String(now), activityCookieOptions(secure));
  }

  return finish(request, out);
}
