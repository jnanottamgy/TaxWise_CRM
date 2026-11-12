"use client";

import * as React from "react";
import { PRESENCE_DEFAULTS } from "@/lib/domain/presence";

/** Never beat more often than this, however often the tab flips between hidden and visible. */
const MIN_GAP_MS = 30_000;

/**
 * When this tab last sent a beat (ms), kept for the tab's lifetime so a full page load doesn't send
 * another straight away: every beat costs a session check and a write, and reloads are frequent.
 */
const LAST_BEAT_KEY = "tw.presence.lastBeat";

function readLastBeat(): number {
  try {
    return Number(window.sessionStorage.getItem(LAST_BEAT_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastBeat(at: number) {
  try {
    window.sessionStorage.setItem(LAST_BEAT_KEY, String(at));
  } catch {
    // Storage is off (private window): the beat simply goes out on every load, as before.
  }
}

/**
 * Sends the presence heartbeat while the app is open and visible (§7.12): every 5 minutes, plus one
 * at once when the tab becomes visible again. A hidden tab sends nothing, so a forgotten tab earns
 * no time; the server caps each beat's credit anyway (lib/domain/presence.ts). Mounted once by the
 * staff layout; renders nothing.
 *
 * It stops for good when the server says the session is over (401) or this person isn't counted
 * (403: no staff record, password still to set, two-step check pending); the next page load starts
 * it again.
 */
export function PresenceHeartbeat() {
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let lastBeat = readLastBeat();
    let inFlight = false;
    const every = PRESENCE_DEFAULTS.heartbeatMinutes * 60_000;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = (delay = every) => {
      clear();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void beat(), Math.max(1_000, delay));
    };

    /** Beat now if one is due; otherwise wait out the rest of the interval since the last one. */
    const beatWhenDue = () => {
      const since = Date.now() - lastBeat;
      if (since >= every) void beat();
      else schedule(every - since);
    };

    const beat = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastBeat < MIN_GAP_MS) {
        schedule();
        return;
      }
      inFlight = true;
      lastBeat = now;
      writeLastBeat(now);
      try {
        const res = await fetch("/api/presence/heartbeat", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (res.status === 401 || res.status === 403) {
          stopped = true;
          clear();
          return;
        }
      } catch {
        // Offline or the server is busy: try again at the next interval.
      } finally {
        inFlight = false;
      }
      schedule();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void beat();
      else clear();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") beatWhenDue();

    return () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
