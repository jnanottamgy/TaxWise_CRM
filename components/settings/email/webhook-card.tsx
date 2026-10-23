import { formatDateTime, formatTimeAgo } from "@/lib/format"
import { CopyButton } from "@/components/app/copy-button"
import { StatusChip } from "@/components/app/status-chip"

/**
 * Settings → Email → Delivery events (§7.13.5 "Delivery events via the Resend webhook"; §18.2
 * "bounce webhook working"). The endpoint to register in Resend, the events to tick, whether the
 * signing secret is set on this deployment (a yes/no, never the value), and when the last event
 * arrived. Server component.
 */

export const WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "domain.updated",
] as const

export function WebhookCard({ url, secretPresent, lastEventAt }: { url: string; secretPresent: boolean; lastEventAt: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">Endpoint</p>
        <div className="mt-1 flex min-w-0 items-center gap-1 rounded-md border border-border bg-surface-2 px-3 py-2">
          <span className="min-w-0 flex-1 font-mono text-sm break-all text-text">{url}</span>
          <CopyButton value={url} label="webhook endpoint" />
        </div>
        <p className="mt-1 text-sm text-text-muted">
          In Resend: Webhooks → Add endpoint → paste this URL and tick the events below. Then copy its signing secret into RESEND_WEBHOOK_SECRET in
          the hosting settings and redeploy.
        </p>
      </div>

      <div className="min-w-0">
        <p className="text-sm font-medium text-text">Events</p>
        <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Webhook events to tick in Resend">
          {WEBHOOK_EVENTS.map((e) => (
            <li key={e} className="rounded-md border border-border px-2 py-0.5 font-mono text-xs text-text">
              {e}
            </li>
          ))}
        </ul>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-text-muted">Signing secret on this deployment</dt>
          <dd className="mt-0.5">
            {secretPresent ? (
              <StatusChip label="Set" tone="success" meaning="Set: RESEND_WEBHOOK_SECRET is present, so signed events from Resend are accepted and anything else is refused." />
            ) : (
              <StatusChip
                label="Missing"
                tone="danger"
                meaning="Missing: without RESEND_WEBHOOK_SECRET every event is refused, so nothing shows as delivered, opened or bounced, and bounced addresses aren't flagged."
              />
            )}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-text-muted">Last event received</dt>
          <dd className="mt-0.5 text-base text-text">
            {lastEventAt ? (
              <span className="num" title={formatDateTime(lastEventAt)}>
                {formatTimeAgo(lastEventAt)}
              </span>
            ) : (
              <span className="text-text-muted">None yet. Send a test email to check the webhook.</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  )
}
