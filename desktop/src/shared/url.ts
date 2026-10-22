/**
 * Origins as Chromium sees them. Node's URL gives a custom scheme like taxwise:// an opaque
 * origin ("null"), while Chromium treats our registered standard scheme as taxwise://panel; so the
 * panel's origin is built by hand, and everything else uses the standard rules.
 *
 * Only http:, https: and taxwise: URLs have an origin here. A blob: URL inherits its creator's
 * origin (blob:https://web.whatsapp.com/… is "https://web.whatsapp.com" to the URL parser), but
 * its content is whatever the page put in it, often a file a client sent: it must never count as
 * the CRM or WhatsApp for navigation, IPC sender checks or permissions. filesystem:, data:,
 * about: and every other scheme are opaque too.
 */

import { PANEL_SCHEME } from "./config";

export function originOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === `${PANEL_SCHEME}:`) return u.host ? `${u.protocol}//${u.host}` : null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin === "null" ? null : u.origin;
}
