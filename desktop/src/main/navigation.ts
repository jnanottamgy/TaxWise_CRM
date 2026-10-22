/**
 * Navigation and new-window rules (§7.25.3). Pure: no Electron imports, so every case is unit-tested.
 *
 * - The CRM view stays inside TAXWISE_APP_URL's origin.
 * - WhatsApp views stay inside https://web.whatsapp.com.
 * - The panel header shows only its own bundled page.
 * - Anything else opens in the system browser, and only for https: URLs.
 * - wa.me and api.whatsapp.com/send links from the CRM become
 *   https://web.whatsapp.com/send?phone=…&text=… in the WhatsApp panel.
 * - No view may open a new Electron window.
 */

import { PANEL_ORIGIN, WHATSAPP_ORIGIN } from "../shared/config";
import { originOf } from "../shared/url";

export type ViewKind = "crm" | "whatsapp" | "panel";

export type NavDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "external"; url: string }
  /** Open a one-to-one hand-off in the WhatsApp panel. */
  | { action: "whatsapp-send"; url: string; phone: string }
  /** A WhatsApp Web link from the CRM that is not a hand-off: just show the panel. */
  | { action: "show-whatsapp" }
  /** window.open of a CRM page: load it in the CRM view instead of a new window. */
  | { action: "navigate-crm"; url: string };

export interface NavOptions {
  /** Origin of TAXWISE_APP_URL, e.g. https://app.twchartered.com */
  appOrigin: string;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Digits only, 8–15 long (E.164 without the +), as the CRM's normaliser produces (§7.13.2). */
function phoneDigits(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(trimmed)) return null;
  return trimmed;
}

export function buildWhatsAppSendUrl(phone: string, text: string | null): string {
  const base = `${WHATSAPP_ORIGIN}/send?phone=${phone}`;
  return text ? `${base}&text=${encodeURIComponent(text)}` : base;
}

/**
 * Recognises a click-to-chat link and returns the WhatsApp Web equivalent, or null.
 * Handles https://wa.me/<digits>?text=…, https://api.whatsapp.com/send?phone=…&text=…
 * and https://web.whatsapp.com/send?phone=…&text=….
 */
export function rewriteWhatsAppLink(raw: string): { url: string; phone: string } | null {
  const u = parse(raw);
  if (!u) return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) return null;
  const host = u.hostname.toLowerCase();
  const text = u.searchParams.get("text");

  if (host === "wa.me" || host === "www.wa.me") {
    const m = /^\/(\+?\d+)\/?$/.exec(u.pathname);
    const phone = phoneDigits(m ? m[1]! : null);
    return phone ? { url: buildWhatsAppSendUrl(phone, text), phone } : null;
  }
  if (host === "api.whatsapp.com" || host === "web.whatsapp.com") {
    if (!/^\/send\/?$/.test(u.pathname)) return null;
    const phone = phoneDigits(u.searchParams.get("phone"));
    return phone ? { url: buildWhatsAppSendUrl(phone, text), phone } : null;
  }
  return null;
}

function isWhatsAppHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "web.whatsapp.com" || h === "api.whatsapp.com" || h === "wa.me" || h === "www.wa.me";
}

function externalOrDeny(u: URL): NavDecision {
  if (u.protocol === "https:") return { action: "external", url: u.href };
  return { action: "deny", reason: `refused ${u.protocol} link` };
}

/** Decision for a main-frame navigation (will-navigate / will-redirect) in a view. */
export function decideNavigation(view: ViewKind, raw: string, opts: NavOptions): NavDecision {
  const u = parse(raw);
  if (!u) return { action: "deny", reason: "not a URL" };

  if (view === "crm") {
    if (u.origin === opts.appOrigin) return { action: "allow" };
    const handoff = rewriteWhatsAppLink(raw);
    if (handoff) return { action: "whatsapp-send", url: handoff.url, phone: handoff.phone };
    if (u.protocol === "https:" && isWhatsAppHost(u.hostname)) return { action: "show-whatsapp" };
    return externalOrDeny(u);
  }

  if (view === "whatsapp") {
    if (u.origin === WHATSAPP_ORIGIN) return { action: "allow" };
    return externalOrDeny(u);
  }

  // panel header: its own bundled pages only; it has no outside links.
  if (originOf(raw) === PANEL_ORIGIN) return { action: "allow" };
  return { action: "deny", reason: "the panel header shows only its own page" };
}

/**
 * The CRM showed one of its signed-out pages: hide the WhatsApp panel at once (§7.25.3 "Signing
 * out of the CRM hides the WhatsApp panel at once"), before the API confirms it.
 */
export function crmShowsSignedOutPage(raw: string, appOrigin: string): boolean {
  const u = parse(raw);
  if (!u || u.origin !== appOrigin) return false;
  return /^\/(login|forgot-password|reset-password|set-password|setup|no-access)(\/|$)/.test(u.pathname);
}

/** Supabase's session cookie (sb-<project>-auth-token, possibly split into .0, .1 …). */
export function isAuthCookie(name: string): boolean {
  return /^sb-[A-Za-z0-9]+-auth-token(\.\d+)?$/.test(name);
}

/** Decision for window.open / target=_blank (setWindowOpenHandler). Never a new Electron window. */
export function decideWindowOpen(view: ViewKind, raw: string, opts: NavOptions): Exclude<NavDecision, { action: "allow" }> {
  const nav = decideNavigation(view, raw, opts);
  if (nav.action !== "allow") return nav;
  if (view === "crm") return { action: "navigate-crm", url: raw };
  return { action: "deny", reason: "new windows are not allowed" };
}
