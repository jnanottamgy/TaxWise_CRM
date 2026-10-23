import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook, webhookHeadersFrom, WEBHOOK_TOLERANCE_SECONDS } from "@/server/email/webhook";

const SECRET = `whsec_${Buffer.from("a-32-byte-test-secret-for-hmac!!").toString("base64")}`;
const BODY = JSON.stringify({ type: "email.delivered", created_at: "2026-10-22T09:00:00.000Z", data: { email_id: "re_123" } });
const NOW = 1_792_000_000;

function headers(sig: string, ts = NOW, id = "msg_2abc") {
  return { id, timestamp: String(ts), signature: sig };
}

describe("Resend webhook signatures (Svix)", () => {
  it("accepts the right signature", () => {
    const sig = signWebhook(SECRET, "msg_2abc", NOW, BODY);
    expect(verifyWebhook(SECRET, headers(`v1,${sig}`), BODY, NOW)).toEqual({ ok: true, id: "msg_2abc", timestamp: NOW });
  });

  it("accepts any one of several signatures (secret rotation)", () => {
    const sig = signWebhook(SECRET, "msg_2abc", NOW, BODY);
    expect(verifyWebhook(SECRET, headers(`v1,AAAA v1,${sig} v2,zzz`), BODY, NOW).ok).toBe(true);
  });

  it("refuses a changed body, id or timestamp", () => {
    const sig = signWebhook(SECRET, "msg_2abc", NOW, BODY);
    expect(verifyWebhook(SECRET, headers(`v1,${sig}`), BODY.replace("delivered", "bounced"), NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhook(SECRET, headers(`v1,${sig}`, NOW, "msg_other"), BODY, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhook(SECRET, headers(`v1,${sig}`, NOW + 1), BODY, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses another secret", () => {
    const other = `whsec_${Buffer.from("another-secret-of-thirty-two-b!!").toString("base64")}`;
    const sig = signWebhook(other, "msg_2abc", NOW, BODY);
    expect(verifyWebhook(SECRET, headers(`v1,${sig}`), BODY, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses replays outside five minutes either way", () => {
    const old = NOW - WEBHOOK_TOLERANCE_SECONDS - 1;
    const sigOld = signWebhook(SECRET, "msg_2abc", old, BODY);
    expect(verifyWebhook(SECRET, headers(`v1,${sigOld}`, old), BODY, NOW)).toEqual({ ok: false, reason: "too_old" });
    const future = NOW + WEBHOOK_TOLERANCE_SECONDS + 1;
    const sigNew = signWebhook(SECRET, "msg_2abc", future, BODY);
    expect(verifyWebhook(SECRET, headers(`v1,${sigNew}`, future), BODY, NOW)).toEqual({ ok: false, reason: "too_new" });
    const edge = NOW - WEBHOOK_TOLERANCE_SECONDS;
    expect(verifyWebhook(SECRET, headers(`v1,${signWebhook(SECRET, "msg_2abc", edge, BODY)}`, edge), BODY, NOW).ok).toBe(true);
  });

  it("refuses missing headers, a bad timestamp, other versions and an empty secret", () => {
    const sig = signWebhook(SECRET, "msg_2abc", NOW, BODY);
    expect(verifyWebhook(SECRET, { id: null, timestamp: String(NOW), signature: `v1,${sig}` }, BODY, NOW)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyWebhook(SECRET, headers(`v1,${sig}`, "abc" as unknown as number), BODY, NOW)).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verifyWebhook(SECRET, headers(`v2,${sig}`), BODY, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhook("whsec_", headers(`v1,${sig}`), BODY, NOW)).toEqual({ ok: false, reason: "bad_secret" });
  });

  it("reads Svix headers first, then the Standard Webhooks names", () => {
    const svix = new Headers({ "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,x", "webhook-id": "b" });
    expect(webhookHeadersFrom((n) => svix.get(n))).toEqual({ id: "a", timestamp: "1", signature: "v1,x" });
    const std = new Headers({ "webhook-id": "b", "webhook-timestamp": "2", "webhook-signature": "v1,y" });
    expect(webhookHeadersFrom((n) => std.get(n))).toEqual({ id: "b", timestamp: "2", signature: "v1,y" });
  });
});
