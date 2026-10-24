import "server-only";

import { createAdminClient } from "@/server/admin";
import { log } from "@/lib/log";

/**
 * Rate limits (§13), backed by the `check_rate_limit(p_key, p_limit, p_window_seconds)` database
 * function. Called through the service-role client because most callers are anonymous (sign-in,
 * password reset, the public quotation page).
 *
 * Fail-open: if the database can't answer, the request is allowed and the failure is logged. A
 * broken limiter must never lock the whole firm out of signing in.
 *
 * Keys never hold raw emails or IP addresses: the identity parts are hashed (SHA-256).
 */

export const RATE_LIMITS = {
  /** §13: 5 sign-in attempts per 15 minutes per email + IP. */
  login: { limit: 5, windowSeconds: 15 * 60 },
  /** §13: 3 password-reset emails per hour per email. */
  passwordReset: { limit: 3, windowSeconds: 60 * 60 },
  /** Authenticator codes per person, against guessing (not in §13's list; same spirit). */
  mfaVerify: { limit: 10, windowSeconds: 15 * 60 },
  /** First-run set-up attempts per IP. */
  setup: { limit: 5, windowSeconds: 15 * 60 },
  /** §13: general server actions, 300 per minute per user (lib/action.ts). */
  serverAction: { limit: 300, windowSeconds: 60 },
  /**
   * Revealing stored portal passwords (§7.15.1, §12), per person: generous for a day of filings,
   * tight enough that a stolen session can't empty the vault in one go. Each reveal is logged too.
   */
  credentialReveal: { limit: 30, windowSeconds: 15 * 60 },
} as const;

export type RateLimitScope = string;

export interface RateLimitResult {
  allowed: boolean;
  /** True when the limiter itself failed and the request was let through. */
  failedOpen: boolean;
}

export interface RateLimitCheck {
  /** Short name for the limit, used in the key and the audit row: "login", "password_reset". */
  scope: RateLimitScope;
  /** What is being limited: e.g. [email, ip]. Hashed into the key; never stored raw. */
  identity: Array<string | null | undefined>;
  limit: number;
  windowSeconds: number;
  /** Written to audit_logs when the limit is exceeded (§13). */
  audit?: { userId?: string | null; email?: string | null; ip?: string | null; userAgent?: string | null };
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `<scope>:<sha256 of the identity parts>`. Parts are trimmed and lower-cased; missing parts count as "-". */
export async function rateLimitKey(scope: RateLimitScope, identity: Array<string | null | undefined>): Promise<string> {
  const normalised = identity.map((p) => (p ?? "-").trim().toLowerCase() || "-").join("|");
  return `${scope}:${await sha256Hex(normalised)}`;
}

/**
 * Reads the function's answer. Accepts the shapes a limiter function commonly returns: a boolean
 * (true = allowed), a row or array of rows with `allowed`, or `{ remaining }`. Anything else is
 * "unknown" and treated as allowed by the caller (fail-open).
 */
export function interpretRateLimitResult(data: unknown): boolean | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row === "boolean") return row;
  if (row && typeof row === "object") {
    const r = row as Record<string, unknown>;
    if (typeof r.allowed === "boolean") return r.allowed;
    if (typeof r.check_rate_limit === "boolean") return r.check_rate_limit;
    if (typeof r.remaining === "number") return r.remaining >= 0;
  }
  return null;
}

/** Counts one attempt and says whether it is within the limit. Never throws. */
export async function checkRateLimit(check: RateLimitCheck): Promise<RateLimitResult> {
  let key: string;
  try {
    key = await rateLimitKey(check.scope, check.identity);
  } catch (err) {
    log("error", "rate limit key failed", { source: `rate-limit:${check.scope}`, err });
    return { allowed: true, failedOpen: true };
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
    const { data, error } = await admin.rpc("check_rate_limit", {
      p_key: key,
      p_limit: check.limit,
      p_window_seconds: check.windowSeconds,
    });
    if (error) throw error;
    const allowed = interpretRateLimitResult(data);
    if (allowed === null) {
      log("warn", "rate limit returned an unknown shape; allowing", { source: `rate-limit:${check.scope}` });
      return { allowed: true, failedOpen: true };
    }
    if (!allowed) await auditLimitExceeded(admin, check);
    return { allowed, failedOpen: false };
  } catch (err) {
    log("error", "rate limit check failed; allowing", { source: `rate-limit:${check.scope}`, err });
    return { allowed: true, failedOpen: true };
  }
}

/** §13: exceeding a limit writes an audit event. Direct service-role insert (the caller may be anonymous). */
async function auditLimitExceeded(admin: ReturnType<typeof createAdminClient>, check: RateLimitCheck): Promise<void> {
  try {
    const { error } = await admin.from("audit_logs").insert({
      event: "access_denied",
      user_id: check.audit?.userId ?? null,
      user_email: check.audit?.email ?? null,
      ip: check.audit?.ip ?? null,
      user_agent: check.audit?.userAgent ?? null,
      resource_type: "rate_limit",
      resource_id: check.scope,
      action: `rate_limit.${check.scope}`,
      details: { limit: check.limit, window_seconds: check.windowSeconds },
      success: false,
      error: "rate limit exceeded",
    });
    if (error) throw error;
  } catch (err) {
    log("error", "rate limit audit write failed", { source: `rate-limit:${check.scope}`, err });
  }
}
