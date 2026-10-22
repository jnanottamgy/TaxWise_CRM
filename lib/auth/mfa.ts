/**
 * Two-step sign-in with an authenticator app (TOTP, §12).
 *
 * Required for Partners and Managers (they see fees and can reveal portal passwords), optional for
 * Employees (turned on from Profile) and Clients. A required role is never let past the proxy or the
 * page guards at assurance level `aal1`; anyone who has turned it on is challenged at sign-in.
 *
 * The pure rules are client-safe. `getMfaState` takes the caller's own Supabase client (it never
 * creates one) so this file can be imported anywhere without pulling in server-only code.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRole } from "@/lib/auth/roles";

export type Aal = "aal1" | "aal2";

/** The roles that must use an authenticator app (§12). */
export const MFA_REQUIRED_ROLES = ["partner", "manager"] as const satisfies readonly AppRole[];

/** Issuer shown in the authenticator app beside the account name. */
export const TOTP_ISSUER = "TaxWise";
/** The factor's name inside Supabase. One TOTP factor per person. */
export const TOTP_FRIENDLY_NAME = "Authenticator app";

export function mfaRequiredFor(role: string | null | undefined): boolean {
  return role === "partner" || role === "manager";
}

export function toAal(value: unknown): Aal | null {
  return value === "aal1" || value === "aal2" ? value : null;
}

/**
 * What the person must do before they can use the app:
 * - "enrol":     their role requires an authenticator app and they have none yet;
 * - "challenge": they have one (required or optional) and this session hasn't been verified with it;
 * - null:        nothing, carry on.
 */
export function mfaStep(input: {
  role: string | null | undefined;
  currentLevel: Aal | null;
  hasVerifiedFactor: boolean;
}): "enrol" | "challenge" | null {
  if (input.currentLevel === "aal2") return null;
  if (input.hasVerifiedFactor) return "challenge";
  return mfaRequiredFor(input.role) ? "enrol" : null;
}

export interface TotpFactorSummary {
  id: string;
  friendlyName: string | null;
  createdAt: string | null;
}

export interface MfaState {
  /** Assurance level of this session's access token. */
  currentLevel: Aal | null;
  verified: TotpFactorSummary[];
  /** Started but never confirmed with a code (an abandoned set-up). */
  unverified: TotpFactorSummary[];
}

interface RawFactor {
  id: string;
  factor_type?: string;
  status?: string;
  friendly_name?: string | null;
  created_at?: string | null;
}

function summarise(f: RawFactor): TotpFactorSummary {
  return { id: f.id, friendlyName: f.friendly_name ?? null, createdAt: f.created_at ?? null };
}

/**
 * Reads the signed-in person's TOTP factors and this session's assurance level.
 * `listFactors` asks the Auth server for the user (it does not trust the cookie's copy), so the
 * factor list is authoritative. Throws on an Auth error; callers decide how to degrade.
 */
export async function getMfaState(supabase: SupabaseClient): Promise<MfaState> {
  const [{ data: factors, error: factorsError }, { data: aal, error: aalError }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (factorsError) throw factorsError;
  if (aalError) throw aalError;
  const all = ((factors?.all ?? []) as RawFactor[]).filter((f) => f.factor_type === "totp");
  return {
    currentLevel: toAal(aal?.currentLevel),
    verified: all.filter((f) => f.status === "verified").map(summarise),
    unverified: all.filter((f) => f.status !== "verified").map(summarise),
  };
}

/** Groups a TOTP secret in fours so it can be typed into an app by hand: "JBSW Y3DP EHPK 3PXP". */
export function formatTotpSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
