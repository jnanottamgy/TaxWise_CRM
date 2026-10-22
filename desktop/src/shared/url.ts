/**
 * Origins as Chromium sees them. Node's URL gives a custom scheme like taxwise:// an opaque
 * origin ("null"), while Chromium treats our registered standard scheme as taxwise://panel; so the
 * panel's origin is built by hand, and everything else uses the standard rules.
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
  return u.origin === "null" ? null : u.origin;
}
