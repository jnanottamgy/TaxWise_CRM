import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Resend webhook (§7.13.5 delivery events). Resend signs with Svix: the headers
 * `svix-id`, `svix-timestamp` and `svix-signature` (or the Standard Webhooks names `webhook-id`,
 * `webhook-timestamp`, `webhook-signature`); the signature is base64 HMAC-SHA256 of
 * `${id}.${timestamp}.${rawBody}` with the secret after its `whsec_` prefix, base64-decoded. The
 * header may carry several space-separated `v1,<signature>` entries (during a secret rotation); any
 * one matching is enough. A timestamp more than five minutes from now is refused (replays).
 *
 * Pure apart from node:crypto; unit-tested in tests/unit/platform-webhook-signature.test.ts.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export type WebhookVerification =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: "missing_headers" | "bad_secret" | "bad_timestamp" | "too_old" | "too_new" | "bad_signature" };

/** Reads the signature headers, Svix names first, then Standard Webhooks names. */
export function webhookHeadersFrom(get: (name: string) => string | null): WebhookHeaders {
  return {
    id: get("svix-id") ?? get("webhook-id"),
    timestamp: get("svix-timestamp") ?? get("webhook-timestamp"),
    signature: get("svix-signature") ?? get("webhook-signature"),
  };
}

function secretKey(secret: string): Buffer | null {
  const raw = secret.trim().replace(/^whsec_/, "");
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length >= 8 ? key : null;
  } catch {
    return null;
  }
}

/** The signature Resend would send for this body (exported for tests). */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = secretKey(secret);
  if (!key) throw new Error("bad webhook secret");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookVerification {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing_headers" };
  const key = secretKey(secret);
  if (!key) return { ok: false, reason: "bad_secret" };
  if (!/^\d{1,12}$/.test(headers.timestamp.trim())) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(headers.timestamp.trim());
  if (nowSeconds - ts > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "too_old" };
  if (ts - nowSeconds > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "too_new" };

  const expected = createHmac("sha256", key).update(`${headers.id}.${ts}.${rawBody}`, "utf8").digest();
  for (const part of headers.signature.trim().split(/\s+/)) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    let given: Buffer;
    try {
      given = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, id: headers.id, timestamp: ts };
  }
  return { ok: false, reason: "bad_signature" };
}
