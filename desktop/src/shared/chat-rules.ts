/**
 * Client mode's rule for one open conversation (§7.25.5), shared by the WhatsApp preload (which
 * enforces it on the page) and the main process (which re-checks open chats after a context
 * refresh). Pure.
 *
 * A chat is allowed if its title is exactly one of the user's allowed group names, or it is a
 * one-to-one chat the CRM itself opened in this session (a hand-off, §7.13.2). Anything else is
 * closed.
 */

import type { ClientModePolicy } from "./types";

/** Unicode-normalised, direction marks removed, whitespace collapsed. Case is kept: names match exactly. */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function titlesEqual(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}

export type ChatVerdict = "none" | "allow" | "adopt" | "deny";

export function decideChat(title: string | null, policy: ClientModePolicy, now: number): ChatVerdict {
  if (!policy.enabled) return title === null ? "none" : "allow";
  if (title === null) return "none";
  const t = normalizeTitle(title);
  if (t.length === 0) return "deny";
  if (policy.allowedGroupNames.some((g) => normalizeTitle(g) === t)) return "allow";
  if (policy.sessionChats.some((c) => normalizeTitle(c) === t)) return "allow";
  const handoff = policy.pendingHandoff;
  if (handoff && now <= handoff.expiresAt) {
    // An unsaved contact shows as its number: it must be the number the CRM opened.
    if (/^[+\d\s().-]+$/.test(t) && t.replace(/\D/g, "") !== handoff.phoneDigits) return "deny";
    return "adopt";
  }
  return "deny";
}

/** "Wed 2026-10-22" in IST: the day key for once-a-day rules. */
export function istDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
