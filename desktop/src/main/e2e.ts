/**
 * End-to-end test support (§14: "client mode, against saved WhatsApp Web page fixtures, never the
 * live WhatsApp in CI"). Only an unpackaged build started with TAXWISE_E2E_WHATSAPP_FIXTURES
 * serves a local fixture as https://web.whatsapp.com/; a packaged app never does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";

export function e2eFixtureDir(isPackaged: boolean, env: NodeJS.ProcessEnv): string | null {
  if (isPackaged) return null;
  const dir = env.TAXWISE_E2E_WHATSAPP_FIXTURES;
  return dir && dir.trim() ? dir : null;
}

export function serveWhatsAppFixtures(ses: Pick<Session, "protocol">, dir: string): void {
  ses.protocol.handle("https", (req) => {
    const u = new URL(req.url);
    if (u.hostname !== "web.whatsapp.com") return new Response("Blocked in tests", { status: 404 });
    if (u.pathname !== "/" && u.pathname !== "/send" && u.pathname !== "/accept") return new Response("Not found", { status: 404 });
    return new Response(readFileSync(join(dir, "whatsapp.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });
}
