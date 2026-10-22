import { describe, expect, it } from "vitest";
import {
  applyHeartbeat,
  assertPresenceParams,
  closeAllAtDayEnd,
  closeAtLastActivity,
  closeOnSignOut,
  heartbeatCreditMinutes,
  isSessionStale,
  minutesBetween,
  PRESENCE_DEFAULTS,
  PRESENCE_SEED_PARAMETERS,
  presenceStatus,
  resolvePresenceParams,
  sweepStaleSessions,
} from "@/lib/domain/presence";

const T0 = new Date("2026-10-22T04:00:00.000Z"); // 09:30 IST
const at = (minutes: number, seconds = 0) => new Date(T0.getTime() + minutes * 60_000 + seconds * 1000);

describe("presence thresholds (§7.12)", () => {
  it("uses the spec's values: beat 5, cap 6, idle 20, stale 45", () => {
    expect(PRESENCE_DEFAULTS).toEqual({ heartbeatMinutes: 5, creditCapMinutes: 6, idleAfterMinutes: 20, staleAfterMinutes: 45 });
  });

  it("keeps the idle < stale invariant, asserted at module load and on demand", () => {
    // The module imported without throwing, so the load-time assertion passed.
    expect(PRESENCE_DEFAULTS.idleAfterMinutes).toBeLessThan(PRESENCE_DEFAULTS.staleAfterMinutes);
    expect(() => assertPresenceParams(PRESENCE_DEFAULTS)).not.toThrow();
    expect(() => assertPresenceParams({ ...PRESENCE_DEFAULTS, idleAfterMinutes: 45 })).toThrow(/idle threshold .* must be below the stale threshold/);
    expect(() => assertPresenceParams({ ...PRESENCE_DEFAULTS, idleAfterMinutes: 50 })).toThrow();
  });

  it("refuses other nonsense: non-positive values, a cap below a beat, beats slower than idle", () => {
    expect(() => assertPresenceParams({ ...PRESENCE_DEFAULTS, creditCapMinutes: 0 })).toThrow();
    expect(() => assertPresenceParams({ ...PRESENCE_DEFAULTS, creditCapMinutes: 4 })).toThrow(/credit cap/);
    expect(() => assertPresenceParams({ ...PRESENCE_DEFAULTS, heartbeatMinutes: 20, creditCapMinutes: 25 })).toThrow(/idle threshold/);
  });

  it("resolves the seeded row, and falls back when a row breaks the invariant", () => {
    expect(PRESENCE_SEED_PARAMETERS[0]).toMatchObject({ key: "presence.thresholds", value: PRESENCE_DEFAULTS, verified: true });
    expect(resolvePresenceParams(PRESENCE_SEED_PARAMETERS, "2026-10-22")).toEqual(PRESENCE_DEFAULTS);
    const bad = [{ key: "presence.thresholds", value: { idleAfterMinutes: 50, staleAfterMinutes: 45 }, effectiveFrom: "2026-04-01" }];
    expect(resolvePresenceParams(bad, "2026-10-22")).toEqual(PRESENCE_DEFAULTS);
    const edited = [{ key: "presence.thresholds", value: { idleAfterMinutes: 15, staleAfterMinutes: 30 }, effectiveFrom: "2026-04-01" }];
    expect(resolvePresenceParams(edited, "2026-10-22")).toEqual({ ...PRESENCE_DEFAULTS, idleAfterMinutes: 15, staleAfterMinutes: 30 });
    expect(resolvePresenceParams([], "2026-10-22")).toEqual(PRESENCE_DEFAULTS);
  });
});

describe("heartbeatCreditMinutes: a capped credit (§7.12)", () => {
  it("credits the minutes since the last beat", () => {
    expect(heartbeatCreditMinutes(at(0), at(5))).toBe(5);
    expect(heartbeatCreditMinutes(at(0), at(1))).toBe(1);
    expect(heartbeatCreditMinutes(at(0).toISOString(), at(5).toISOString())).toBe(5);
  });

  it("caps one beat at 6 minutes, however long the gap", () => {
    expect(heartbeatCreditMinutes(at(0), at(6))).toBe(6);
    expect(heartbeatCreditMinutes(at(0), at(10))).toBe(6);
    expect(heartbeatCreditMinutes(at(0), at(44))).toBe(6);
    expect(heartbeatCreditMinutes(at(0), at(10), { ...PRESENCE_DEFAULTS, creditCapMinutes: 8 })).toBe(8);
  });

  it("gives a duplicate beat nothing, and never goes negative", () => {
    expect(heartbeatCreditMinutes(at(5), at(5))).toBe(0);
    expect(heartbeatCreditMinutes(at(5), at(5, 20))).toBe(0);
    expect(heartbeatCreditMinutes(at(5), at(3))).toBe(0);
  });

  it("can't be inflated by early beats: beats every 30 seconds for 10 minutes earn 10 minutes", () => {
    let last = at(0);
    let total = 0;
    for (let s = 30; s <= 600; s += 30) {
      const now = at(0, s);
      total += heartbeatCreditMinutes(last, now);
      last = now;
    }
    expect(total).toBe(10);
  });

  it("loses nothing to jitter: beats landing a little early still add up to the elapsed time", () => {
    // Beats at 4m59.9s intervals, starting 10 s into a minute: 6 beats ≈ 29m59s.
    let last = at(0, 10);
    let total = 0;
    for (let i = 1; i <= 6; i++) {
      const now = new Date(last.getTime() + 299_900);
      total += heartbeatCreditMinutes(last, now);
      last = now;
    }
    expect(total).toBeGreaterThanOrEqual(29);
    expect(total).toBeLessThanOrEqual(30);
  });

  it("throws for an unreadable timestamp", () => {
    expect(() => heartbeatCreditMinutes("not a date", at(1))).toThrow(RangeError);
  });
});

describe("presenceStatus (§7.12)", () => {
  it("Online < 20 min · Idle 20–45 min · Offline > 45 min", () => {
    expect(presenceStatus(at(0), at(0))).toBe("online");
    expect(presenceStatus(at(0), at(19, 59))).toBe("online");
    expect(presenceStatus(at(0), at(20))).toBe("idle");
    expect(presenceStatus(at(0), at(45))).toBe("idle");
    expect(presenceStatus(at(0), at(45, 1))).toBe("offline");
    expect(presenceStatus(at(0), at(300))).toBe("offline");
  });

  it("no open session is Offline; a beat ahead of the clock is Online", () => {
    expect(presenceStatus(null, at(0))).toBe("offline");
    expect(presenceStatus(undefined, at(0))).toBe("offline");
    expect(presenceStatus(at(2), at(0))).toBe("online");
  });

  it("measures minutes exactly", () => {
    expect(minutesBetween(at(0), at(1, 30))).toBe(1.5);
  });
});

describe("sessions: opening, crediting and closing (§7.12)", () => {
  const session = { loginAt: at(0), lastActiveAt: at(30), activeMinutes: 28 };

  it("a beat with no open session opens one at now", () => {
    expect(applyHeartbeat(null, at(0))).toEqual({ kind: "open", open: { loginAt: at(0), lastActiveAt: at(0), activeMinutes: 0, isActive: true } });
  });

  it("a beat on an open session credits min(now − last, 6) and moves last_active_at to now", () => {
    expect(applyHeartbeat(session, at(35))).toEqual({ kind: "credit", creditMinutes: 5, lastActiveAt: at(35), activeMinutes: 33 });
    expect(applyHeartbeat(session, at(50))).toEqual({ kind: "credit", creditMinutes: 6, lastActiveAt: at(50), activeMinutes: 34 });
    // A beat from a clock behind the last one credits nothing and doesn't move last_active_at back.
    expect(applyHeartbeat(session, at(29))).toEqual({ kind: "credit", creditMinutes: 0, lastActiveAt: at(30), activeMinutes: 28 });
  });

  it("a beat on a session already silent 45 minutes closes it at its last activity and opens a new one", () => {
    const r = applyHeartbeat(session, at(75));
    expect(r.kind).toBe("reopen");
    if (r.kind !== "reopen") return;
    expect(r.close).toEqual({ logoutAt: at(30), durationMinutes: 28, activeMinutes: 28, closedReason: "stale", isActive: false });
    expect(r.open).toEqual({ loginAt: at(75), lastActiveAt: at(75), activeMinutes: 0, isActive: true });
  });

  it("is stale from 45 minutes of silence", () => {
    expect(isSessionStale(session, at(74, 59))).toBe(false);
    expect(isSessionStale(session, at(75))).toBe(true);
  });

  it("the sweep closes silent sessions at their LAST activity time, not at now", () => {
    const fresh = { id: "a", loginAt: at(0), lastActiveAt: at(60), activeMinutes: 55 };
    const silent = { id: "b", loginAt: at(0), lastActiveAt: at(10), activeMinutes: 10 };
    const closed = sweepStaleSessions([fresh, silent], at(70));
    expect(closed).toHaveLength(1);
    expect(closed[0].session.id).toBe("b");
    expect(closed[0].close.logoutAt).toEqual(at(10));
    expect(closed[0].close.durationMinutes).toBe(10);
    expect(closed[0].close.closedReason).toBe("stale");
  });

  it("forgotten tabs never earn hours: closing adds no time", () => {
    expect(closeAtLastActivity(session, "stale").activeMinutes).toBe(28);
  });

  it("sign-out credits the last stretch and closes at now", () => {
    expect(closeOnSignOut(session, at(33))).toEqual({ logoutAt: at(33), durationMinutes: 31, activeMinutes: 31, closedReason: "logout", isActive: false });
  });

  it("sign-out of a stale session closes it at its last activity", () => {
    expect(closeOnSignOut(session, at(200))).toEqual({ logoutAt: at(30), durationMinutes: 28, activeMinutes: 28, closedReason: "stale", isActive: false });
  });

  it("the nightly job closes every open session at its last activity", () => {
    const late = { id: "late", loginAt: at(0), lastActiveAt: at(860), activeMinutes: 400 };
    const old = { id: "old", loginAt: at(0), lastActiveAt: at(300), activeMinutes: 250 };
    const closed = closeAllAtDayEnd([late, old], at(870));
    expect(closed.map((c) => [c.session.id, c.close.closedReason, c.close.logoutAt.getTime()])).toEqual([
      ["late", "day_end", at(860).getTime()],
      ["old", "stale", at(300).getTime()],
    ]);
  });
});
