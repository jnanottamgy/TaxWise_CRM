import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { log, logUnexpected } from "@/lib/log";
import { appGateHeaders, appGateTokenHash } from "@/lib/supabase/app-gate";
import { untyped } from "@/lib/supabase/untyped";
import { createAdminClient, type AdminSupabase } from "@/server/admin";

/**
 * Keeps the database API gate (migration 0243, lib/supabase/app-gate.ts) registered and switched on.
 *
 * `ensureApiGate()` runs at every scheduler check. It registers this server's token, proves through
 * the API that the database recognises it (the canary), and only then switches enforcement on, so
 * the gate can never close on the app itself. With API_GATE=off in the environment it opens the gate
 * instead. A database that doesn't have the gate yet (migrations behind) is left alone.
 */

export type ApiGateState =
  | "on" // enforced, and this server's token is registered
  | "armed" // switched on by this call
  | "off" // open: API_GATE=off, or not switched on yet
  | "no_token" // this server has no CREDENTIAL_VAULT_KEY to derive a token from
  | "not_installed" // the database has no gate (apply the migrations)
  | "canary_failed"; // the database didn't recognise the token through the API; left open

export interface ApiGateStatus {
  state: ApiGateState;
  enforce: boolean;
  tokens: number;
  armedAt: string | null;
  /** The API server is configured to call the gate (pgrst.db_pre_request on `authenticator`). */
  hook: boolean | null;
  detail?: string;
}

interface GateRow {
  enforce: boolean;
  tokens: number;
  armed_at: string | null;
  hook?: boolean;
}

function missingFunction(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? ""));
}

function gateWanted(): boolean {
  return (process.env.API_GATE ?? "").trim().toLowerCase() !== "off";
}

async function register(admin: AdminSupabase, hash: string | null, enforce: boolean | null): Promise<{ row: GateRow | null; missing: boolean }> {
  const { data, error } = await untyped(admin).rpc("api_gate_register", { p_token_hash: hash, p_enforce: enforce });
  if (error) {
    if (missingFunction(error)) return { row: null, missing: true };
    throw error;
  }
  return { row: data as GateRow, missing: false };
}

/** Registers this server's token (enforcement untouched). True when the database accepted it. */
export async function registerAppGateToken(): Promise<boolean> {
  const hash = appGateTokenHash();
  if (!hash) return false;
  try {
    const { row } = await register(createAdminClient(), hash, null);
    if (row) log("warn", "api gate: token registered again after a refusal", { source: "api-gate" });
    return row !== null;
  } catch (err) {
    logUnexpected(err, { source: "api-gate:register" });
    return false;
  }
}

/** The canary: an anonymous API call that carries the token; true when the database recognised it. */
async function databaseSeesApp(): Promise<boolean> {
  const probe = createSupabaseClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: appGateHeaders() },
  });
  const { data, error } = await untyped(probe).rpc("api_gate_sees_app");
  if (error) {
    log("warn", "api gate: canary call failed", { source: "api-gate", code: error.code, message: error.message });
    return false;
  }
  return data === true;
}

export async function ensureApiGate(adminClient?: AdminSupabase): Promise<ApiGateStatus> {
  const admin = adminClient ?? createAdminClient();
  const blank = { enforce: false, tokens: 0, armedAt: null, hook: null };

  if (!gateWanted()) {
    const { row, missing } = await register(admin, null, false);
    if (missing) return { state: "not_installed", ...blank };
    return { state: "off", enforce: false, tokens: row?.tokens ?? 0, armedAt: null, hook: null, detail: "API_GATE=off" };
  }

  const hash = appGateTokenHash();
  if (!hash) return { state: "no_token", ...blank };

  const first = await register(admin, hash, null);
  if (first.missing || !first.row) return { state: "not_installed", ...blank };
  if (first.row.enforce) return { state: "on", enforce: true, tokens: first.row.tokens, armedAt: first.row.armed_at, hook: null };

  if (!(await databaseSeesApp())) {
    log("error", "api gate: the database didn't recognise this server's token through the API; the gate stays open", { source: "api-gate" });
    return { state: "canary_failed", enforce: false, tokens: first.row.tokens, armedAt: null, hook: null };
  }
  const armed = await register(admin, hash, true);
  log("info", "api gate: switched on", { source: "api-gate" });
  return { state: "armed", enforce: true, tokens: armed.row?.tokens ?? first.row.tokens, armedAt: armed.row?.armed_at ?? null, hook: null };
}

/** For Settings → Diagnostics: what the database says about the gate. */
export async function readApiGateStatus(): Promise<ApiGateStatus> {
  const admin = createAdminClient();
  const { data, error } = await untyped(admin).rpc("api_gate_status");
  if (error) {
    if (missingFunction(error)) return { state: "not_installed", enforce: false, tokens: 0, armedAt: null, hook: null };
    throw error;
  }
  const row = data as GateRow;
  return {
    state: row.enforce ? "on" : "off",
    enforce: row.enforce,
    tokens: row.tokens,
    armedAt: row.armed_at,
    hook: row.hook ?? null,
    detail: gateWanted() ? undefined : "API_GATE=off",
  };
}
