/**
 * TAXWISE_APP_URL (§17): the CRM URL TaxWise Desktop loads, set at build time in desktop/ and
 * baked into the bundle. A locked-down run (a release bundle or a packaged app, see hardening.ts)
 * uses only the baked value, and only over https. A development run may point at a local CRM
 * (http://localhost or 127.0.0.1) through the environment.
 */

export type AppUrlResult = { ok: true; url: URL } | { ok: false; error: string };

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function resolveAppUrl(baked: string, envOverride: string | undefined, lockedDown: boolean): AppUrlResult {
  const raw = (lockedDown ? baked : envOverride || baked).trim();
  if (!raw) return { ok: false, error: "TAXWISE_APP_URL was not set when this app was built." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `TAXWISE_APP_URL is not a URL: ${raw}` };
  }
  if (url.username || url.password) return { ok: false, error: "TAXWISE_APP_URL must not contain a user name or password." };
  if (url.protocol === "https:") return { ok: true, url };
  if (!lockedDown && url.protocol === "http:" && isLoopback(url.hostname)) return { ok: true, url };
  return { ok: false, error: "TAXWISE_APP_URL must be an https:// address." };
}
