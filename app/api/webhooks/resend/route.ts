import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { applyResendEvent, type ResendWebhookPayload } from "@/server/email/events";
import { verifyWebhook, webhookHeadersFrom } from "@/server/email/webhook";

/**
 * Resend delivery events (§7.13.1, §7.13.5): delivered / opened / bounced / complained / failed, and
 * domain status changes. The proxy lets /api/webhooks/* through without a session
 * (lib/supabase/proxy.ts MACHINE_PREFIXES); the request is trusted only when its Svix signature
 * matches RESEND_WEBHOOK_SECRET (server/email/webhook.ts). Each delivery is applied once
 * (server/email/events.ts).
 *
 * In Resend: Webhooks → Add endpoint → `<NEXT_PUBLIC_APP_URL>/api/webhooks/resend`, events
 * email.sent, email.delivered, email.delivery_delayed, email.opened, email.bounced,
 * email.complained, email.failed, email.suppressed, domain.updated; put its signing secret in
 * RESEND_WEBHOOK_SECRET. Settings → Email shows the URL and when the last event arrived.
 *
 * Answers `{ ok, data | error, ref }` (CONVENTIONS §3.5): 200 once applied (or deliberately
 * ignored), 401 for a bad signature, 503 when the secret isn't set, 500 with a Ref when applying
 * failed (Resend retries).
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;

function respond(body: Record<string, unknown>, status: number): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(request: Request) {
  try {
    const secret = env.resendWebhookSecret()?.trim();
    if (!secret) {
      log("warn", "Resend webhook received but RESEND_WEBHOOK_SECRET isn't set", { source: "route:/api/webhooks/resend" });
      return respond({ ok: false, error: "Webhook signing secret isn't configured.", code: "not_configured" }, 503);
    }
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return respond({ ok: false, error: "Payload too large." }, 413);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return respond({ ok: false, error: "Payload too large." }, 413);

    const verified = verifyWebhook(secret, webhookHeadersFrom((n) => request.headers.get(n)), raw);
    if (!verified.ok) {
      log("warn", "Resend webhook refused", { source: "route:/api/webhooks/resend", reason: verified.reason });
      return respond({ ok: false, error: "The webhook signature didn't match.", code: "forbidden" }, 401);
    }

    let payload: ResendWebhookPayload;
    try {
      payload = JSON.parse(raw) as ResendWebhookPayload;
    } catch {
      return respond({ ok: false, error: "The webhook body isn't JSON." }, 400);
    }
    if (!payload || typeof payload !== "object" || typeof payload.type !== "string") {
      return respond({ ok: false, error: "The webhook body has no event type." }, 400);
    }

    const result = await applyResendEvent(verified.id, payload);
    return respond({ ok: true, data: result }, 200);
  } catch (err) {
    const ref = logUnexpected(err, { source: "route:/api/webhooks/resend" });
    return respond({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
