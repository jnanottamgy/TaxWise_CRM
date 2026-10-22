"use server";

import QRCode from "qrcode";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { createClient as createSupabaseClient, isAuthWeakPasswordError, type AuthError } from "@supabase/supabase-js";
import { defineAction } from "@/lib/action";
import { fail, ok, unexpectedMessage, type ActionResult, type FieldErrors } from "@/lib/result";
import { log, logUnexpected } from "@/lib/log";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/server/admin";
import { homePathFor, isAppRole } from "@/lib/auth/roles";
import { formatTotpSecret, getMfaState, mfaRequiredFor, TOTP_FRIENDLY_NAME, TOTP_ISSUER } from "@/lib/auth/mfa";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { destinationFor } from "@/lib/supabase/proxy";
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  MfaCodeSchema,
  NewPasswordSchema,
  SignInSchema,
  type ForgotPasswordInput,
  type SignInInput,
} from "@/lib/schemas/auth";
import {
  auditAuthEvent,
  cameFromEmailLink,
  clearActivityClock,
  clearMustChangePassword,
  loadProfileForSignIn,
  requestMeta,
  startActivityClock,
  syncAppMetadata,
} from "@/server/auth";

/**
 * Sign-in, sign-out, password and two-step sign-in actions (§4.4, §12, §13).
 *
 * `signIn`, `requestPasswordReset` and `signOut` run without a profile (or without a session at
 * all), so they can't use defineAction; they follow the same contract by hand: a plain sentence,
 * field errors, a Ref for anything unexpected, and redirect signals re-thrown.
 */

const WRONG_CREDENTIALS = "Email or password is incorrect.";
const TOO_MANY_SIGN_INS = "Too many attempts. Try again in 15 minutes, or reset your password.";
const CHECK_FIELDS = "Please check the highlighted fields.";

function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function unexpected(err: unknown, source: string, userId: string | null = null): ActionResult<never> {
  unstable_rethrow(err);
  const ref = logUnexpected(err, { source, userId });
  return fail(unexpectedMessage(ref), { code: "unexpected", ref });
}

/** Supabase answered, but not about the credentials: down, unreachable or misconfigured. */
function isServiceFailure(error: AuthError): boolean {
  return !error.status || error.status >= 500;
}

// -------------------------------------------------------------------------------------------------
// Sign in (§3.5, §4.4)
// -------------------------------------------------------------------------------------------------

export async function signIn(input: SignInInput): Promise<ActionResult<{ redirectTo: string }>> {
  let userId: string | null = null;
  try {
    const meta = await requestMeta();
    const parsed = SignInSchema.safeParse(input);
    if (!parsed.success) {
      return fail(CHECK_FIELDS, { code: "validation", fieldErrors: fieldErrorsOf(parsed.error) });
    }
    const { email, password, next } = parsed.data;

    // §13: 5 attempts per 15 minutes per email + IP.
    const limit = await checkRateLimit({
      scope: "login",
      identity: [email, meta.ip],
      ...RATE_LIMITS.login,
      audit: { email, ip: meta.ip, userAgent: meta.userAgent },
    });
    if (!limit.allowed) {
      await auditAuthEvent({ event: "login_failure", action: "auth.sign_in", success: false, error: "rate_limited", email, meta });
      return fail(TOO_MANY_SIGN_INS, { code: "rate_limited" });
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      await auditAuthEvent({
        event: "login_failure",
        action: "auth.sign_in",
        success: false,
        error: error?.code ?? error?.message ?? "no user returned",
        email,
        meta,
      });
      if (error?.status === 429 || error?.code === "over_request_rate_limit") {
        return fail(TOO_MANY_SIGN_INS, { code: "rate_limited" });
      }
      if (error && isServiceFailure(error)) return unexpected(error, "action:auth.sign_in");
      // One message for every credential problem: never reveal whether the email has a login.
      return fail(WRONG_CREDENTIALS, { code: "unauthenticated" });
    }

    const user = data.user;
    userId = user.id;

    let profile: Awaited<ReturnType<typeof loadProfileForSignIn>>;
    try {
      profile = await loadProfileForSignIn(user.id);
    } catch (err) {
      // Don't leave someone half signed in when we can't tell who they are.
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      return unexpected(err, "action:auth.sign_in:profile", user.id);
    }

    // §4.4: a session without a profile gets a clear page, never a crash.
    if (!profile || !isAppRole(profile.role)) {
      await auditAuthEvent({
        event: "login_success",
        action: "auth.sign_in",
        success: true,
        details: { profile: "missing" },
        userId: user.id,
        email,
        meta,
        supabase,
      });
      await startActivityClock();
      return ok({ redirectTo: "/no-access" });
    }

    if (!profile.isActive) {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      await auditAuthEvent({
        event: "login_failure",
        action: "auth.sign_in",
        success: false,
        error: "disabled",
        userId: user.id,
        email,
        role: profile.role,
        meta,
      });
      return fail("Your access has been disabled. Ask a Partner.", { code: "forbidden" });
    }

    const role = profile.role;

    // §4.5 step 5: the JWT hint follows profiles.role (and the forced-change flag); repair it here.
    try {
      const sync = await syncAppMetadata(user.id, user.app_metadata, profile);
      if (sync.changed) {
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) log("warn", "session refresh after app_metadata repair failed", { source: "action:auth.sign_in", userId: user.id, err: refreshError });
        await auditAuthEvent({
          event: "permission_change",
          action: "auth.repair_app_metadata",
          success: true,
          details: { from: sync.from, to: { role, must_change_password: profile.mustChangePassword } },
          userId: user.id,
          email,
          role,
          meta,
          supabase,
        });
      }
    } catch (err) {
      // Not fatal: the proxy sends someone without a role hint to /no-access, and the next sign-in retries.
      log("error", "app_metadata repair failed", { source: "action:auth.sign_in", userId: user.id, role, err });
    }

    try {
      const { error: touchError } = await createAdminClient()
        .from("profiles")
        .update({ last_login_at: new Date().toISOString() })
        .eq("id", user.id);
      if (touchError) throw touchError;
    } catch (err) {
      log("warn", "last_login_at update failed", { source: "action:auth.sign_in", userId: user.id, err });
    }

    const hasAuthenticator = (user.factors ?? []).some((f) => f.status === "verified");
    const needsMfa = mfaRequiredFor(role) || hasAuthenticator;
    await auditAuthEvent({
      event: "login_success",
      action: "auth.sign_in",
      success: true,
      details: { aal: "aal1", mfa_next: needsMfa },
      userId: user.id,
      email,
      role,
      meta,
      supabase,
    });
    await startActivityClock();

    const destination = destinationFor(role, next);
    if (profile.mustChangePassword) return ok({ redirectTo: "/set-password" });
    if (needsMfa) return ok({ redirectTo: `/mfa?next=${encodeURIComponent(destination)}` });
    return ok({ redirectTo: destination });
  } catch (err) {
    return unexpected(err, "action:auth.sign_in", userId);
  }
}

// -------------------------------------------------------------------------------------------------
// Forgot password (§4.4): Supabase sends the reset link
// -------------------------------------------------------------------------------------------------

export async function requestPasswordReset(input: ForgotPasswordInput): Promise<ActionResult<{ email: string }>> {
  try {
    const meta = await requestMeta();
    const parsed = ForgotPasswordSchema.safeParse(input);
    if (!parsed.success) {
      return fail(CHECK_FIELDS, { code: "validation", fieldErrors: fieldErrorsOf(parsed.error) });
    }
    const { email } = parsed.data;

    // §13: 3 per hour per email.
    const limit = await checkRateLimit({
      scope: "password_reset",
      identity: [email],
      ...RATE_LIMITS.passwordReset,
      audit: { email, ip: meta.ip, userAgent: meta.userAgent },
    });
    if (!limit.allowed) {
      return fail("Too many reset requests for this email. Try again in an hour.", { code: "rate_limited" });
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${env.appUrl().replace(/\/$/, "")}/auth/confirm?next=/reset-password`,
    });
    if (error) {
      if (error.status === 429 || error.code === "over_email_send_rate_limit") {
        return fail("We couldn't send the email just now. Try again in a few minutes.", { code: "rate_limited" });
      }
      if (isServiceFailure(error)) return unexpected(error, "action:auth.password_reset");
      // Any other refusal is answered like a success, so the form never reveals who has a login.
      log("warn", "password reset refused", { source: "action:auth.password_reset", err: error });
    }

    await auditAuthEvent({
      event: "user_update",
      action: "auth.password_reset_requested",
      success: !error,
      error: error?.code ?? null,
      email,
      meta,
    });
    return ok({ email });
  } catch (err) {
    return unexpected(err, "action:auth.password_reset");
  }
}

// -------------------------------------------------------------------------------------------------
// New password: the reset link's page and the forced change after a temporary password (§4.4)
// -------------------------------------------------------------------------------------------------

function passwordErrorResult(error: AuthError): ActionResult<never> | null {
  const onField = (message: string) => fail(CHECK_FIELDS, { code: "validation", fieldErrors: { password: [message] } });
  if (error.code === "same_password") return onField("Choose a password different from the one you use now.");
  if (error.code === "weak_password" || isAuthWeakPasswordError(error)) {
    const reasons = isAuthWeakPasswordError(error) ? error.reasons : [];
    return onField(
      reasons.includes("pwned")
        ? "This password has appeared in a data leak on another website. Choose a different one."
        : "Choose a stronger password: longer, with a mix of letters, numbers and symbols.",
    );
  }
  if (error.code === "insufficient_aal") {
    return fail("Enter the code from your authenticator app first, then set your password.", { code: "blocked" });
  }
  if (error.code === "reauthentication_needed" || error.code === "reauthentication_not_valid") {
    return fail("For your security, sign out, sign in again, then set your password.", { code: "blocked" });
  }
  if (error.code === "session_not_found" || error.status === 401) {
    return fail("Your session has ended. Please sign in again.", { code: "unauthenticated" });
  }
  return null;
}

export const setNewPassword = defineAction(
  { name: "auth.set_password", schema: NewPasswordSchema, allowMustChangePassword: true, allowPendingMfa: true },
  async ({ password }, ctx) => {
    const forced = ctx.user.mustChangePassword;
    // Without the current password, only a forced change or a fresh reset-link session may do this.
    if (!forced && !(await cameFromEmailLink(ctx.supabase))) {
      return fail("To change your password, open the reset link from your email, or use Profile.", { code: "blocked" });
    }
    const { error } = await ctx.supabase.auth.updateUser({ password });
    if (error) {
      await ctx.audit({
        event: "password_change",
        resourceType: "auth",
        resourceId: ctx.user.id,
        success: false,
        error: error.code ?? error.message,
      });
      const known = passwordErrorResult(error);
      if (known) return known;
      throw error;
    }

    // The forced-change gate lifts only when both the authority and the JWT hint say so.
    if (forced) await clearMustChangePassword(ctx.user.id);
    await ctx.audit({
      event: "password_change",
      resourceType: "auth",
      resourceId: ctx.user.id,
      details: { forced },
    });

    // A fresh access token carries the updated app_metadata, so the proxy stops redirecting.
    const { error: refreshError } = await ctx.supabase.auth.refreshSession();
    if (refreshError) log("warn", "session refresh after password change failed", { source: "action:auth.set_password", userId: ctx.user.id, err: refreshError });

    ctx.after(
      "Sign out other devices",
      async () => {
        const { error: othersError } = await ctx.supabase.auth.signOut({ scope: "others" });
        if (othersError) throw othersError;
      },
      "Your password is changed, but other devices may still be signed in. Sign them out from Profile.",
    );
    return ok({ redirectTo: homePathFor(ctx.user.role) });
  },
);

// -------------------------------------------------------------------------------------------------
// Sign out (§4.4): revokes the session on the server
// -------------------------------------------------------------------------------------------------

export async function signOut(): Promise<ActionResult<{ redirectTo: string }>> {
  let userId: string | null = null;
  try {
    const meta = await requestMeta();
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const user = data?.user ?? null;
    userId = user?.id ?? null;

    if (user) {
      // Written before the session goes, so it is recorded under the person's own session.
      await auditAuthEvent({
        event: "logout",
        action: "auth.sign_out",
        success: true,
        userId: user.id,
        email: user.email ?? null,
        role: typeof user.app_metadata?.role === "string" ? user.app_metadata.role : null,
        meta,
        supabase,
      });
    }

    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      log("warn", "sign-out revoke failed; clearing cookies", { source: "action:auth.sign_out", userId, err: error });
      const store = await cookies();
      for (const c of store.getAll()) if (c.name.startsWith("sb-")) store.delete(c.name);
    }
    await clearActivityClock();
    return ok({ redirectTo: "/login?reason=signed_out" });
  } catch (err) {
    return unexpected(err, "action:auth.sign_out", userId);
  }
}

// -------------------------------------------------------------------------------------------------
// Two-step sign-in with an authenticator app (§12)
// -------------------------------------------------------------------------------------------------

export interface MfaEnrolment {
  factorId: string;
  /** PNG data URL of the otpauth:// QR code. */
  qrDataUrl: string;
  /** The secret grouped in fours, for typing in by hand. */
  secret: string;
}

export const startMfaEnrolment = defineAction(
  { name: "auth.mfa_enrol_start", schema: z.object({}), allowPendingMfa: true },
  async (_input, ctx): Promise<ActionResult<MfaEnrolment>> => {
    const state = await getMfaState(ctx.supabase);
    if (state.verified.length > 0) {
      return fail("Two-step sign-in is already on for your account.", { code: "blocked" });
    }
    // An abandoned set-up leaves an unverified factor behind; clear it so the name is free.
    for (const f of state.unverified) {
      const { error } = await ctx.supabase.auth.mfa.unenroll({ factorId: f.id });
      if (error) log("warn", "could not remove an unverified factor", { source: "action:auth.mfa_enrol_start", userId: ctx.user.id, err: error });
    }

    let enrolled = await ctx.supabase.auth.mfa.enroll({ factorType: "totp", issuer: TOTP_ISSUER, friendlyName: TOTP_FRIENDLY_NAME });
    if (enrolled.error?.code === "mfa_factor_name_conflict") {
      enrolled = await ctx.supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: TOTP_ISSUER,
        friendlyName: `${TOTP_FRIENDLY_NAME} (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
      });
    }
    if (enrolled.error || !enrolled.data) throw enrolled.error ?? new Error("enroll returned no data");

    const { id, totp } = enrolled.data;
    const qrDataUrl = await QRCode.toDataURL(totp.uri, { margin: 1, width: 200, errorCorrectionLevel: "M" });
    return ok({ factorId: id, qrDataUrl, secret: formatTotpSecret(totp.secret) });
  },
);

export const verifyMfa = defineAction(
  { name: "auth.mfa_verify", schema: MfaCodeSchema, allowMustChangePassword: true, allowPendingMfa: true },
  async ({ factorId, code, next }, ctx) => {
    const limit = await checkRateLimit({
      scope: "mfa_verify",
      identity: [ctx.user.id],
      ...RATE_LIMITS.mfaVerify,
      audit: { userId: ctx.user.id, email: ctx.user.email, ip: ctx.ip, userAgent: ctx.userAgent },
    });
    if (!limit.allowed) return fail("Too many attempts. Try again in 15 minutes.", { code: "rate_limited" });

    const state = await getMfaState(ctx.supabase);
    const enrolling = state.unverified.some((f) => f.id === factorId);
    if (!enrolling && !state.verified.some((f) => f.id === factorId)) {
      return fail("That set-up has expired. Start again.", { code: "not_found" });
    }
    const action = enrolling ? "auth.mfa_enrol" : "auth.mfa_verify";

    const { error } = await ctx.supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      await ctx.audit({
        event: "login_failure",
        resourceType: "auth",
        resourceId: ctx.user.id,
        action,
        success: false,
        error: error.code ?? error.message,
      });
      if (error.status === 429 || error.code === "over_request_rate_limit") {
        return fail("Too many attempts. Try again in 15 minutes.", { code: "rate_limited" });
      }
      if (error.code === "mfa_verification_failed" || error.code === "mfa_verification_rejected" || error.status === 422 || error.status === 400) {
        return fail(CHECK_FIELDS, {
          code: "validation",
          fieldErrors: {
            code: ["That code didn't match. Use the newest code in your app, and check your phone's clock is set automatically."],
          },
        });
      }
      throw error;
    }

    await ctx.audit(
      enrolling
        ? { event: "user_update", resourceType: "auth", resourceId: ctx.user.id, action, details: { factor: "totp" } }
        : { event: "login_success", resourceType: "auth", resourceId: ctx.user.id, action, details: { aal: "aal2" } },
    );
    return ok({ redirectTo: destinationFor(ctx.user.role, next) });
  },
);

// -------------------------------------------------------------------------------------------------
// Change password from Profile (§7.1): current, new, confirm
// -------------------------------------------------------------------------------------------------

export const changePassword = defineAction(
  { name: "auth.change_password", schema: ChangePasswordSchema },
  async ({ current, password }, ctx) => {
    const limit = await checkRateLimit({
      scope: "login",
      identity: [ctx.user.email, ctx.ip],
      ...RATE_LIMITS.login,
      audit: { userId: ctx.user.id, email: ctx.user.email, ip: ctx.ip, userAgent: ctx.userAgent },
    });
    if (!limit.allowed) return fail(TOO_MANY_SIGN_INS, { code: "rate_limited" });

    // Prove the current password with a throwaway client, so the person's own session is untouched.
    const probe = createSupabaseClient(env.supabaseUrl(), env.supabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: proof, error: proofError } = await probe.auth.signInWithPassword({ email: ctx.user.email, password: current });
    if (proofError || !proof.session) {
      await ctx.audit({ event: "password_change", resourceType: "auth", resourceId: ctx.user.id, success: false, error: "current password wrong" });
      if (proofError && isServiceFailure(proofError)) throw proofError;
      return fail(CHECK_FIELDS, { code: "validation", fieldErrors: { current: ["That isn't your current password."] } });
    }
    // Revoke the probe's own session straight away.
    await probe.auth.signOut({ scope: "local" }).catch(() => undefined);

    const { error } = await ctx.supabase.auth.updateUser({ password });
    if (error) {
      await ctx.audit({ event: "password_change", resourceType: "auth", resourceId: ctx.user.id, success: false, error: error.code ?? error.message });
      const known = passwordErrorResult(error);
      if (known) return known;
      throw error;
    }
    await ctx.audit({ event: "password_change", resourceType: "auth", resourceId: ctx.user.id, details: { via: "profile" } });
    ctx.after(
      "Sign out other devices",
      async () => {
        const { error: othersError } = await ctx.supabase.auth.signOut({ scope: "others" });
        if (othersError) throw othersError;
      },
      "Your password is changed, but other devices may still be signed in. Sign them out from Profile.",
    );
    return ok({ changed: true as const });
  },
);
