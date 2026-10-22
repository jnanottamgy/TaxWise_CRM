import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { log, logUnexpected } from "@/lib/log";
import { safeNextPath } from "@/lib/supabase/proxy";
import { auditAuthEvent, requestMeta, startActivityClock } from "@/server/auth";

/**
 * Where Supabase's emails land (§4.4): turns a one-time link into a session, then redirects.
 *
 * Handles both link shapes:
 * - `?token_hash=…&type=recovery` (the recommended email template, works on any device);
 * - `?code=…` (Supabase's default PKCE redirect, works in the browser that asked for the email).
 *
 * A password-reset link always goes on to /reset-password; anything else to a same-origin `next`.
 * A link that fails goes to a page that says so, never to an error screen.
 */

const OTP_TYPES = new Set<string>(["recovery", "invite", "magiclink", "email", "signup", "email_change"]);
/** Destinations an email link may name even though they are not ordinary landing pages. */
const LINK_DESTINATIONS = new Set(["/reset-password", "/set-password"]);

function redirectTo(request: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");
  const nextRaw = params.get("next");
  const isRecovery = type === "recovery" || nextRaw === "/reset-password";

  const linkNext = nextRaw && LINK_DESTINATIONS.has(nextRaw) ? nextRaw : null;
  const success = isRecovery ? "/reset-password" : type === "invite" ? "/set-password" : (linkNext ?? safeNextPath(nextRaw, "/") ?? "/");
  // /reset-password without a session explains that the link has expired and offers a new one.
  const failure = isRecovery ? "/reset-password" : "/login?reason=link";

  // Supabase sends people back with ?error=… when the link was already used or has expired.
  if (params.get("error") || params.get("error_code")) {
    log("info", "email link refused by Supabase", { source: "route:/auth/confirm", code: params.get("error_code") });
    return redirectTo(request, failure);
  }

  try {
    const supabase = await createClient();
    let verified = false;
    let method = "none";

    if (tokenHash && type && OTP_TYPES.has(type)) {
      method = `otp:${type}`;
      const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
      if (error) log("info", "email link verification failed", { source: "route:/auth/confirm", code: error.code, type });
      verified = !error;
    } else if (code) {
      method = "pkce";
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) log("info", "email link code exchange failed", { source: "route:/auth/confirm", code: error.code });
      verified = !error;
    }

    if (!verified) return redirectTo(request, failure);

    const { data } = await supabase.auth.getUser();
    const user = data.user;
    await startActivityClock();
    await auditAuthEvent({
      event: "login_success",
      action: "auth.email_link",
      success: true,
      details: { method },
      userId: user?.id ?? null,
      email: user?.email ?? null,
      role: typeof user?.app_metadata?.role === "string" ? user.app_metadata.role : null,
      meta: await requestMeta(),
      supabase,
    });
    return redirectTo(request, success);
  } catch (err) {
    logUnexpected(err, { source: "route:/auth/confirm" });
    return redirectTo(request, failure);
  }
}
