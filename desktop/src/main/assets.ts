/**
 * Serving the panel header from the app bundle over the privileged taxwise:// scheme, never
 * file:// (Electron security checklist). Only files inside the renderer folder, only known types.
 */

import { PANEL_HOST, PANEL_SCHEME } from "../shared/config";

/** The panel header's Content-Security-Policy (also in its <meta> tag). */
export const PANEL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function contentTypeFor(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : (TYPES[path.slice(dot).toLowerCase()] ?? null);
}

/**
 * The bundled file for a taxwise://panel/<path> URL, as a path relative to the renderer folder,
 * or null for anything else (other hosts, traversal, unknown types, hidden files).
 */
export function resolveBundledAsset(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== `${PANEL_SCHEME}:` || u.hostname !== PANEL_HOST || u.username || u.password || u.port) return null;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (path.includes("\\") || path.includes("\0")) return null;
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === ".." || p.startsWith("."))) return null;
  const rel = parts.join("/");
  return contentTypeFor(rel) ? rel : null;
}
