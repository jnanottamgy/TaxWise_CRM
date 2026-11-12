import "server-only";

import { createHash, createHmac } from "node:crypto";

/**
 * The app server's proof of identity to the database API (migration 0243).
 *
 * The publishable key and a login are enough to call Supabase's database API from anywhere, which
 * skips every rule that lives in the app's server actions. So the database refuses API requests that
 * don't carry this token (PostgREST `db_pre_request` → `public.api_gate()`), and only this server
 * can produce it: it is derived from CREDENTIAL_VAULT_KEY, which never reaches a browser. The
 * database stores only the token's SHA-256.
 *
 * `appGateHeaders()` goes on every user-scoped Supabase client the server creates
 * (lib/supabase/server.ts). The service-role client needs nothing: the gate lets that role through.
 */
export const APP_GATE_HEADER = "x-taxwise-app";

let cache: { key: string; token: string; hash: string } | null = null;

function derive(): { token: string; hash: string } | null {
  const key = process.env.CREDENTIAL_VAULT_KEY;
  if (!key) return null; // local runs without a vault key: no token, and the gate stays open there
  if (cache?.key === key) return cache;
  const token = createHmac("sha256", key).update("taxwise:api-gate:v1").digest("hex");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  cache = { key, token, hash };
  return cache;
}

/** The token itself: only ever sent to this project's own Supabase API, over TLS. */
export function appGateToken(): string | null {
  return derive()?.token ?? null;
}

/** What the database keeps: SHA-256 of the token, hex. */
export function appGateTokenHash(): string | null {
  return derive()?.hash ?? null;
}

export function appGateHeaders(): Record<string, string> {
  const token = appGateToken();
  return token ? { [APP_GATE_HEADER]: token } : {};
}

/** The gate's own refusal (HTTP 403 with the TWGATE marker), as opposed to an RLS denial. */
export function isGateRefusal(status: number, body: string): boolean {
  return status === 403 && body.includes("TWGATE");
}

let healing: Promise<boolean> | null = null;
let lastHealAt = 0;
const HEAL_EVERY_MS = 30_000;

/**
 * `fetch` for the user-scoped client. If the gate refuses this server (its secret changed since the
 * token was registered), register the current token with the service role and send the request once
 * more, so a change of secret never takes the app down. Everything else passes straight through.
 */
export const gateAwareFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 403) return res;
  let body = "";
  try {
    body = await res.clone().text();
  } catch {
    return res;
  }
  if (!isGateRefusal(res.status, body)) return res;
  if (!healing) {
    if (Date.now() - lastHealAt < HEAL_EVERY_MS) return res;
    healing = (async () => {
      try {
        const { registerAppGateToken } = await import("@/server/api-gate");
        return await registerAppGateToken();
      } catch {
        return false;
      } finally {
        lastHealAt = Date.now();
      }
    })();
  }
  const healed = await healing;
  healing = null;
  return healed ? fetch(input, init) : res;
};
