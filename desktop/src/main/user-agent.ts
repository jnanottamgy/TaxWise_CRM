/**
 * WhatsApp Web refuses browsers it doesn't recognise (§7.25.3). Every WhatsApp partition gets the
 * Chrome user agent of the bundled Chromium before its first load, on navigator.userAgent and on
 * every request header. If the "WhatsApp works with Google Chrome" block still appears, the
 * partition's cache is cleared and the page reloaded once.
 */

import type { Session, WebContents } from "electron";

/** "138.0.7204.35" → "138" */
export function chromeMajor(chromeVersion: string | undefined): string {
  const m = /^(\d+)\./.exec(chromeVersion ?? "");
  if (!m) throw new Error(`Unexpected Chromium version: ${String(chromeVersion)}`);
  return m[1]!;
}

const PLATFORM_TOKENS: Record<string, string> = {
  win32: "Windows NT 10.0; Win64; x64",
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  linux: "X11; Linux x86_64",
};

/** The Chrome string of the bundled Chromium, with the reduced "<major>.0.0.0" version Chrome itself sends. */
export function chromeUserAgent(chromeVersion: string | undefined, platform: string): string {
  const token = PLATFORM_TOKENS[platform] ?? PLATFORM_TOKENS.win32!;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor(chromeVersion)}.0.0.0 Safari/537.36`;
}

/** A user agent that would make WhatsApp refuse the page. */
export function looksLikeElectron(userAgent: string): boolean {
  return /Electron\/|taxwise-desktop\//i.test(userAgent);
}

export function userAgentMatches(reported: string | null, expected: string): boolean {
  return reported !== null && reported === expected;
}

type UaSession = Pick<Session, "setUserAgent" | "webRequest">;

/** Call before the partition's first load. */
export function applyWhatsAppUserAgent(ses: UaSession, userAgent: string): void {
  ses.setUserAgent(userAgent, "en-IN,en-GB,en");
  ses.webRequest.onBeforeSendHeaders({ urls: ["https://*.whatsapp.com/*", "https://*.whatsapp.net/*"] }, (details, callback) => {
    const headers = { ...details.requestHeaders, "User-Agent": userAgent };
    callback({ requestHeaders: headers });
  });
}

/**
 * The cache-clear fallback: clear this partition's HTTP cache and reload once.
 * Returns false if it already ran for this view (the caller then shows the block as is).
 */
export async function clearCacheAndReload(ses: Pick<Session, "clearCache">, wc: Pick<WebContents, "reloadIgnoringCache">, alreadyTried: boolean): Promise<boolean> {
  if (alreadyTried) return false;
  await ses.clearCache();
  wc.reloadIgnoringCache();
  return true;
}
