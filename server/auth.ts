import "server-only";

import { cookies, headers } from "next/headers";
import type { AuditEvent } from "@/lib/action";
import type { ServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/server/admin";
import { log } from "@/lib/log";
import { ACTIVITY_COOKIE, activityCookieOptions } from "@/lib/supabase/proxy";
import { FIRM_DEFAULTS, type FirmDetails } from "@/lib/auth/firm-defaults";

/**
 * Server helpers shared by the sign-in, password, MFA and first-run actions and pages.
 * Used by server/actions/auth.ts, server/actions/setup.ts, app/auth/confirm and the (auth) pages.
 */

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, userAgent: h.get("user-agent") };
}

function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Starts the idle-timeout clock at sign-in (§4.4); the proxy keeps it moving after that. */
export async function startActivityClock(): Promise<void> {
  const store = await cookies();
  store.set(ACTIVITY_COOKIE, String(Date.now()), activityCookieOptions(secureCookies()));
}

export async function clearActivityClock(): Promise<void> {
  const store = await cookies();
  store.set(ACTIVITY_COOKIE, "", { ...activityCookieOptions(secureCookies()), maxAge: 0 });
}

export interface AuthAuditEntry {
  event: AuditEvent;
  /** "auth.sign_in", "auth.sign_out", "auth.password_change", "auth.mfa_verify", "setup.first_partner" … */
  action: string;
  success: boolean;
  error?: string | null;
  details?: Record<string, unknown>;
  meta: RequestMeta;
  /** Who it was about, when known. Used for the service-role insert. */
  userId?: string | null;
  email?: string | null;
  role?: string | null;
  /**
   * The person's own session client, when they have one: the row then goes through the
   * insert-only `log_audit_event` function like every other audit row (§4.6).
   */
  supabase?: ServerSupabase | null;
}

/**
 * Writes one audit row for a sign-in, sign-out, password change or MFA event (§4.4, §12). Never
 * throws: auditing must not block someone from signing in. With a session it uses
 * `log_audit_event`; anonymous events (a failed sign-in) and any failure of that call fall back to
 * a direct service-role insert, which is the only way to record who tried what without a session.
 */
export async function auditAuthEvent(entry: AuthAuditEntry): Promise<void> {
  if (entry.supabase) {
    try {
      const { error } = await entry.supabase.rpc("log_audit_event", {
        p_event: entry.event,
        p_resource_type: "auth",
        p_resource_id: entry.userId ?? null,
        p_action: entry.action,
        p_details: (entry.details ?? {}) as never,
        p_success: entry.success,
        p_error: entry.error ?? null,
        p_ip: entry.meta.ip,
        p_user_agent: entry.meta.userAgent,
      });
      if (!error) return;
      throw error;
    } catch (err) {
      log("warn", "log_audit_event failed; writing with the service role", { source: `audit:${entry.action}`, userId: entry.userId ?? null, err });
    }
  }
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("audit_logs").insert({
      event: entry.event,
      user_id: entry.userId ?? null,
      user_email: entry.email ?? null,
      user_role: entry.role ?? null,
      ip: entry.meta.ip,
      user_agent: entry.meta.userAgent,
      resource_type: "auth",
      resource_id: entry.userId ?? null,
      action: entry.action,
      details: entry.details ?? {},
      success: entry.success,
      error: entry.error ?? null,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "auth audit write failed", { source: `audit:${entry.action}`, userId: entry.userId ?? null, err });
  }
}

/**
 * Profile facts the sign-in flow needs, read with the service role because the session cookie
 * written a moment ago is not yet on the request. Only ever called for the user who just proved
 * their password.
 */
export interface SignInProfile {
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  fullName: string;
}

export async function loadProfileForSignIn(userId: string): Promise<SignInProfile | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("role, is_active, must_change_password, full_name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    role: String(data.role),
    isActive: Boolean(data.is_active),
    mustChangePassword: Boolean(data.must_change_password),
    fullName: String(data.full_name ?? ""),
  };
}

/**
 * Keeps the JWT hint in step with the authority (§4.5 step 5): copies `profiles.role` and
 * `profiles.must_change_password` into `app_metadata` when they differ. Returns true when it wrote.
 */
export async function syncAppMetadata(
  userId: string,
  current: Record<string, unknown> | undefined,
  profile: Pick<SignInProfile, "role" | "mustChangePassword">,
): Promise<{ changed: boolean; from: Record<string, unknown> }> {
  const from = { role: current?.role ?? null, must_change_password: current?.must_change_password ?? null };
  const roleOk = current?.role === profile.role;
  const flagOk = (current?.must_change_password === true) === profile.mustChangePassword;
  if (roleOk && flagOk) return { changed: false, from };
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { role: profile.role, must_change_password: profile.mustChangePassword },
  });
  if (error) throw error;
  return { changed: true, from };
}

/** Clears the forced-change flag in both places after a successful password change (§4.4). */
export async function clearMustChangePassword(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error: profileError } = await admin.from("profiles").update({ must_change_password: false }).eq("id", userId);
  if (profileError) throw profileError;
  const { error: authError } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { must_change_password: false },
  });
  if (authError) throw authError;
}

// -------------------------------------------------------------------------------------------------
// First run (§4.3)
// -------------------------------------------------------------------------------------------------

/**
 * True while no one has a profile yet. Checked on every request to /setup and again inside the
 * set-up action (§4.3: after that, /setup is a 404 forever). Throws if the database can't answer.
 */
export async function isFirstRun(): Promise<boolean> {
  const admin = createAdminClient();
  const { count, error } = await admin.from("profiles").select("id", { count: "exact", head: true });
  if (error) throw error;
  return (count ?? 0) === 0;
}

/** The stored firm details (§5.2 firm_settings) over the §1 defaults, for the first-run form. */
export async function loadFirmDetailsForSetup(): Promise<FirmDetails> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("firm_settings")
    .select("firm_name, tagline, address, city, state_code, pincode, phone, email, website, gstin, pan")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  const pick = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  return {
    firmName: pick(data?.firm_name, FIRM_DEFAULTS.firmName),
    tagline: pick(data?.tagline, FIRM_DEFAULTS.tagline),
    address: pick(data?.address, FIRM_DEFAULTS.address),
    city: pick(data?.city, FIRM_DEFAULTS.city),
    stateCode: pick(data?.state_code, FIRM_DEFAULTS.stateCode),
    pincode: pick(data?.pincode, FIRM_DEFAULTS.pincode),
    phone: pick(data?.phone, FIRM_DEFAULTS.phone),
    firmEmail: pick(data?.email, FIRM_DEFAULTS.firmEmail),
    website: pick(data?.website, FIRM_DEFAULTS.website),
    gstin: pick(data?.gstin, FIRM_DEFAULTS.gstin),
    pan: pick(data?.pan, FIRM_DEFAULTS.pan),
  };
}

// -------------------------------------------------------------------------------------------------
// Password changes without the current password
// -------------------------------------------------------------------------------------------------

/** Sign-in methods that prove the person just opened a link from their own inbox. */
const EMAIL_LINK_METHODS = new Set(["recovery", "otp", "magiclink", "invite", "email/signup"]);
/** How long after opening the link the session may set a new password. */
const EMAIL_LINK_WINDOW_SECONDS = 60 * 60;

/**
 * True when this session began from an email link (a password reset) in the last hour, read from
 * the verified token's `amr` claim. Only such a session, or a forced change after a temporary
 * password, may set a new password without typing the current one (§4.4). Profile's change
 * password asks for the current one instead.
 */
export async function cameFromEmailLink(supabase: ServerSupabase): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return false;
    const now = Math.floor(Date.now() / 1000);
    const amr = (data.claims.amr ?? []) as Array<string | { method?: string; timestamp?: number }>;
    return amr.some((entry) => {
      const method = typeof entry === "string" ? entry : entry.method;
      const at = typeof entry === "string" ? undefined : entry.timestamp;
      return !!method && EMAIL_LINK_METHODS.has(method) && (at === undefined || now - at <= EMAIL_LINK_WINDOW_SECONDS);
    });
  } catch (err) {
    log("warn", "amr check failed", { source: "auth:cameFromEmailLink", err });
    return false;
  }
}
