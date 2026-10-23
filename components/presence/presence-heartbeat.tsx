"use client";

import * as React from "react";
import { PRESENCE_DEFAULTS } from "@/lib/domain/presence";

/** Never beat more often than this, however often the tab flips between hidden and visible. */
const MIN_GAP_MS = 30_000;

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
    let lastBeat = 0;
    let inFlight = false;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clear();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void beat(), PRESENCE_DEFAULTS.heartbeatMinutes * 60_000);
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
    if (document.visibilityState === "visible") void beat();

    return () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
