/**
 * HS256 tokens and Supabase-shaped sessions for the local QA stack. The secret is the stack's
 * throwaway one (.local-stack/secrets.json); none of this works against a real Supabase project.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SUPABASE_URL } from "./config";
import { U, type UserKey } from "../../tests/db/fixtures";

export type Claims = Record<string, unknown> & { sub?: string; exp?: number; role?: string; aal?: string };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function signJwt(claims: Claims, secret: string): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** The claims of a token signed with `secret` that hasn't expired, else null. */
export function verifyJwt(token: string | null | undefined, secret: string): Claims | null {
  const [h, b, s] = (token ?? "").split(".");
  if (!h || !b || !s) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url"));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(b, "base64url").toString()) as Claims;
    if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The project API keys PostgREST and supabase-js expect (`role` picks the database role). */
export function apiKey(role: "anon" | "service_role", secret: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ iss: "taxwise-local-qa", role, iat, exp: iat + 10 * 365 * 24 * 3600 }, secret);
}

// -------------------------------------------------------------------------------------------------
// Fixture users as auth users
// -------------------------------------------------------------------------------------------------

/** What the stand-in knows about a sign-in-able user (written to .local-stack/users.json). */
export type AuthUser = {
  key: string;
  id: string;
  email: string;
  appRole: string;
  userMetadata: Record<string, unknown>;
  /** Has a verified authenticator app (Partners and Managers must, §12). */
  totp: boolean;
};

export function fixtureAuthUsers(): AuthUser[] {
  return (Object.keys(U) as UserKey[]).map((key) => {
    const u = U[key];
    return {
      key,
      id: u.id,
      email: u.email,
      appRole: u.jwtRole,
      userMetadata: u.userMetadata,
      totp: u.profileRole === "partner" || u.profileRole === "manager",
    };
  });
}

export const TOTP_FACTOR_ID = (userId: string) => `${userId.slice(0, 24)}f0f0f0f0f0f0`;

/** The user object GoTrue returns from /auth/v1/user. */
export function authUserObject(u: AuthUser, now = new Date()) {
  const ts = now.toISOString();
  return {
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    email_confirmed_at: "2026-04-01T04:30:00Z",
    phone: "",
    confirmed_at: "2026-04-01T04:30:00Z",
    last_sign_in_at: ts,
    app_metadata: { provider: "email", providers: ["email"], role: u.appRole },
    user_metadata: u.userMetadata,
    identities: [],
    created_at: "2026-04-01T04:30:00Z",
    updated_at: ts,
    is_anonymous: false,
    ...(u.totp
      ? {
          factors: [
            {
              id: TOTP_FACTOR_ID(u.id),
              friendly_name: "Authenticator app",
              factor_type: "totp",
              status: "verified",
              created_at: "2026-04-01T04:35:00Z",
              updated_at: "2026-04-01T04:35:00Z",
            },
          ],
        }
      : {}),
  };
}

export type Session = {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: ReturnType<typeof authUserObject>;
};

/** A signed-in session. Staff with an authenticator app get aal2 (they've passed the code step). */
export function sessionFor(u: AuthUser, secret: string, opts: { ttlSeconds?: number; aal?: "aal1" | "aal2" } = {}): Session {
  const ttl = opts.ttlSeconds ?? 12 * 3600;
  const now = Math.floor(Date.now() / 1000);
  const aal = opts.aal ?? (u.totp ? "aal2" : "aal1");
  const amr = [{ method: "password", timestamp: now - 60 }, ...(aal === "aal2" ? [{ method: "totp", timestamp: now - 30 }] : [])];
  const claims: Claims = {
    iss: `${SUPABASE_URL}/auth/v1`,
    aud: "authenticated",
    sub: u.id,
    email: u.email,
    phone: "",
    role: "authenticated",
    app_metadata: { provider: "email", providers: ["email"], role: u.appRole },
    user_metadata: u.userMetadata,
    aal,
    amr,
    session_id: `qa-${u.key}`,
    is_anonymous: false,
    iat: now,
    exp: now + ttl,
  };
  return {
    access_token: signJwt(claims, secret),
    token_type: "bearer",
    expires_in: ttl,
    expires_at: now + ttl,
    refresh_token: `qa-refresh.${u.key}.${aal}`,
    user: authUserObject(u),
  };
}

/** The @supabase/ssr auth cookie(s) for a session (base64url encoding, chunked at 3180 chars). */
export function authCookies(session: Session): Array<{ name: string; value: string }> {
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const CHUNK = 3180;
  if (value.length <= CHUNK) return [{ name, value }];
  const out: Array<{ name: string; value: string }> = [];
  for (let i = 0; i * CHUNK < value.length; i++) out.push({ name: `${name}.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) });
  return out;
}

export function cookieHeader(session: Session): string {
  return authCookies(session)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
