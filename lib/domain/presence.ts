/**
 * Presence: heartbeats, online status and session closing (§7.12, §5.2 `employee_sessions`).
 *
 * - **Heartbeat:** every 5 minutes while the app is open and visible, plus one when the tab becomes
 *   visible again. The server credits `min(now − last_active_at, 6 minutes)` to the open session's
 *   `active_minutes` and moves `last_active_at` to now. A beat with no open session opens one.
 *   The credit counts the whole clock minutes elapsed between the two instants (minute boundaries
 *   crossed), so summed over a session it equals the real elapsed time: an early or duplicate beat
 *   earns nothing extra, and a beat that lands a few milliseconds early loses nothing.
 * - **Status:** Online (last beat < 20 min) · Idle (20–45 min) · Offline (> 45 min, or no open
 *   session). Invariant: the idle threshold is below the stale threshold, asserted at module load.
 * - **Closing:** a session silent for 45 minutes is closed at its **last activity time** (not at
 *   now), so forgotten tabs never earn hours. Explicit sign-out closes it too. The nightly job
 *   (00:15 IST) closes every session still open, at its last activity.
 *
 * All thresholds are parameters (`PRESENCE_DEFAULTS` holds the spec's values). Pure and
 * client-safe; "now" is always passed in.
 */

import type { DateString } from "@/lib/domain/fy";
import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce } from "@/lib/domain/gst";

export type PresenceParams = {
  /** The browser beats this often while visible. */
  heartbeatMinutes: number;
  /** The most one beat can credit. */
  creditCapMinutes: number;
  /** Idle from this many minutes since the last beat. */
  idleAfterMinutes: number;
  /** Offline after this; a session silent this long is closed at its last activity. */
  staleAfterMinutes: number;
};

/** The §7.12 values: beat every 5 min, credit at most 6, idle from 20, stale at 45. */
export const PRESENCE_DEFAULTS: PresenceParams = {
  heartbeatMinutes: 5,
  creditCapMinutes: 6,
  idleAfterMinutes: 20,
  staleAfterMinutes: 45,
};

/**
 * Throws unless the thresholds make sense (§7.12): all positive; idle < stale (the stated
 * invariant); a beat fits inside the credit cap (or every beat would lose time); and a beat comes
 * before the idle threshold (or a working person would show Idle).
 */
export function assertPresenceParams(p: PresenceParams): void {
  for (const [name, v] of Object.entries(p)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`Presence: ${name} must be a positive number of minutes.`);
  }
  if (!(p.idleAfterMinutes < p.staleAfterMinutes)) {
    throw new Error(`Presence: the idle threshold (${p.idleAfterMinutes} min) must be below the stale threshold (${p.staleAfterMinutes} min).`);
  }
  if (p.heartbeatMinutes > p.creditCapMinutes) throw new Error("Presence: the credit cap must be at least one heartbeat interval.");
  if (!(p.heartbeatMinutes < p.idleAfterMinutes)) throw new Error("Presence: heartbeats must come more often than the idle threshold.");
}

// The invariant is checked when the module loads (§7.12).
assertPresenceParams(PRESENCE_DEFAULTS);

/** The `statutory_parameters` key holding the presence thresholds (one row keeps the invariant together). */
export const PRESENCE_PARAM_KEYS = {
  /** `{"heartbeatMinutes": 5, "creditCapMinutes": 6, "idleAfterMinutes": 20, "staleAfterMinutes": 45}`. */
  thresholds: "presence.thresholds",
} as const;

/** The presence row of `supabase/seed/42_params_practice.sql` (§16). Firm practice, seeded verified. */
export const PRESENCE_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: PRESENCE_PARAM_KEYS.thresholds,
    value: { ...PRESENCE_DEFAULTS },
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    statute: "Firm practice",
    sectionRef: "§7.12 presence and attendance engine",
    sourceRef: "TaxWise Practice OS specification §7.12",
    notes: "Heartbeat every 5 minutes while the app is visible; each beat credits at most 6 minutes; Online under 20 minutes, Idle 20–45, Offline after 45, when a silent session is closed at its last activity. The idle threshold must stay below the stale threshold.",
    verified: true,
  },
];

/**
 * The presence thresholds in force on a date (§5.12), falling back to the defaults when the row is
 * missing or would break the invariant.
 */
export function resolvePresenceParams(rows: readonly StatutoryParameterRow[], on: DateString): PresenceParams {
  const value = parameterInForce(rows, PRESENCE_PARAM_KEYS.thresholds, on)?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...PRESENCE_DEFAULTS };
  const o = value as Record<string, unknown>;
  const candidate = { ...PRESENCE_DEFAULTS };
  for (const k of Object.keys(candidate) as (keyof PresenceParams)[]) {
    if (typeof o[k] === "number") candidate[k] = o[k] as number;
  }
  try {
    assertPresenceParams(candidate);
    return candidate;
  } catch {
    return { ...PRESENCE_DEFAULTS };
  }
}

// -------------------------------------------------------------------------------------------------
// Time helpers
// -------------------------------------------------------------------------------------------------

/** An instant: a `Date`, or an ISO timestamp as Postgres returns `timestamptz`. */
export type Instant = Date | string;

const MINUTE_MS = 60_000;

/** Milliseconds since the epoch; throws a RangeError for an unreadable value. */
export function instantMs(value: Instant): number {
  const ms = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Not a timestamp: ${String(value)}`);
  return ms;
}

/** Exact minutes from `from` to `to` (fractional; negative when `to` is earlier). */
export function minutesBetween(from: Instant, to: Instant): number {
  return (instantMs(to) - instantMs(from)) / MINUTE_MS;
}

// -------------------------------------------------------------------------------------------------
// Heartbeat credit and status
// -------------------------------------------------------------------------------------------------

/**
 * The minutes one heartbeat credits (§7.12): `min(now − last_active_at, cap)`, counted in whole
 * clock minutes elapsed, never negative (a clock behind the last beat credits 0).
 */
export function heartbeatCreditMinutes(lastActiveAt: Instant, now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): number {
  const elapsed = Math.floor(instantMs(now) / MINUTE_MS) - Math.floor(instantMs(lastActiveAt) / MINUTE_MS);
  return Math.max(0, Math.min(elapsed, Math.floor(params.creditCapMinutes)));
}

export type PresenceStatus = "online" | "idle" | "offline";

export const PRESENCE_STATUS_LABELS: Record<PresenceStatus, string> = { online: "Online", idle: "Idle", offline: "Offline" };

/**
 * Online (< idle), Idle (idle to stale, inclusive), Offline (> stale), from the open session's last
 * beat (§7.12). No open session (null) is Offline.
 */
export function presenceStatus(lastActiveAt: Instant | null | undefined, now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): PresenceStatus {
  if (lastActiveAt === null || lastActiveAt === undefined) return "offline";
  const silent = minutesBetween(lastActiveAt, now);
  if (silent < params.idleAfterMinutes) return "online";
  if (silent <= params.staleAfterMinutes) return "idle";
  return "offline";
}

// -------------------------------------------------------------------------------------------------
// Sessions
// -------------------------------------------------------------------------------------------------

export type SessionClosedReason = "logout" | "stale" | "day_end";

/** The open-session columns these rules read (`employee_sessions`). */
export type OpenSession = { loginAt: Instant; lastActiveAt: Instant; activeMinutes: number };

/** What closing a session writes. */
export type SessionClose = {
  logoutAt: Date;
  /** `duration_minutes`, copied from the accumulated `active_minutes` (§5.2). */
  durationMinutes: number;
  activeMinutes: number;
  closedReason: SessionClosedReason;
  isActive: false;
};

/** A new session opened by a beat or a sign-in: `login_at = last_active_at = now`, nothing credited. */
export type NewSession = { loginAt: Date; lastActiveAt: Date; activeMinutes: 0; isActive: true };

function newSession(now: Instant): NewSession {
  const at = new Date(instantMs(now));
  return { loginAt: at, lastActiveAt: at, activeMinutes: 0, isActive: true };
}

/** True when the session has been silent for the stale threshold or longer (§7.12: closed). */
export function isSessionStale(session: Pick<OpenSession, "lastActiveAt">, now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): boolean {
  return minutesBetween(session.lastActiveAt, now) >= params.staleAfterMinutes;
}

/** Closes a session at its **last activity** (stale sweep and nightly close): no time is added. */
export function closeAtLastActivity(session: OpenSession, reason: Exclude<SessionClosedReason, "logout">): SessionClose {
  return {
    logoutAt: new Date(instantMs(session.lastActiveAt)),
    durationMinutes: session.activeMinutes,
    activeMinutes: session.activeMinutes,
    closedReason: reason,
    isActive: false,
  };
}

/**
 * Sign-out (§7.12): credits the last stretch (capped) and closes at now. A session already stale is
 * closed at its last activity instead, so a forgotten tab still earns nothing.
 */
export function closeOnSignOut(session: OpenSession, now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): SessionClose {
  if (isSessionStale(session, now, params)) return closeAtLastActivity(session, "stale");
  const activeMinutes = session.activeMinutes + heartbeatCreditMinutes(session.lastActiveAt, now, params);
  return { logoutAt: new Date(instantMs(now)), durationMinutes: activeMinutes, activeMinutes, closedReason: "logout", isActive: false };
}

export type HeartbeatOutcome =
  | { kind: "open"; open: NewSession }
  | { kind: "credit"; creditMinutes: number; lastActiveAt: Date; activeMinutes: number }
  | { kind: "reopen"; close: SessionClose; open: NewSession };

/**
 * What one heartbeat does (§7.12):
 * - no open session → open one (`login_at = now`);
 * - an open session not yet stale → credit `min(now − last_active_at, cap)` and set
 *   `last_active_at = now`;
 * - an open session already stale (the sweep hasn't run yet) → close it at its last activity and
 *   open a new one, so the silent gap is never credited.
 */
export function applyHeartbeat(session: OpenSession | null, now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): HeartbeatOutcome {
  if (session === null) return { kind: "open", open: newSession(now) };
  if (isSessionStale(session, now, params)) return { kind: "reopen", close: closeAtLastActivity(session, "stale"), open: newSession(now) };
  const creditMinutes = heartbeatCreditMinutes(session.lastActiveAt, now, params);
  const lastMs = Math.max(instantMs(session.lastActiveAt), instantMs(now)); // never move backwards
  return { kind: "credit", creditMinutes, lastActiveAt: new Date(lastMs), activeMinutes: session.activeMinutes + creditMinutes };
}

/** The open sessions the sweep closes now, each at its last activity, reason `stale` (§7.12). */
export function sweepStaleSessions<S extends OpenSession>(sessions: readonly S[], now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): { session: S; close: SessionClose }[] {
  return sessions.filter((s) => isSessionStale(s, now, params)).map((session) => ({ session, close: closeAtLastActivity(session, "stale") }));
}

/**
 * The nightly close (00:15 IST, §7.12, §8): every session still open, each at its last activity.
 * Sessions already silent past the stale threshold are recorded as `stale`, the rest as `day_end`.
 */
export function closeAllAtDayEnd<S extends OpenSession>(sessions: readonly S[], now: Instant, params: PresenceParams = PRESENCE_DEFAULTS): { session: S; close: SessionClose }[] {
  return sessions.map((session) => ({ session, close: closeAtLastActivity(session, isSessionStale(session, now, params) ? "stale" : "day_end") }));
}
