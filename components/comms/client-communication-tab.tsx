import { unstable_rethrow } from "next/navigation"
import type { ClientTabProps } from "@/components/client360/types"
import { ErrorBlock } from "@/components/app/error-block"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getMessagingContext } from "@/lib/data/clients"
import { getThread } from "@/lib/data/threads"
import { COMM_CHANNEL_FILTERS, THREAD_MAX_PAGES, isCommChannelFilter, type CommChannelFilter } from "@/lib/schemas/inbox"
import { ClientThread } from "@/components/comms/client-thread"

/**
 * Client 360 → Communication (§7.3.3 tab 11): every message with this client across WhatsApp
 * hand-offs, the portal and call notes (and any earlier emails), in one thread view, each with
 * the status the app may claim for its channel (§7.13.1); templates; "Log a call"; and a portal
 * reply. Read under the viewer's RLS: an Employee never sees a message about fees, invoices or
 * quotations. Opening it marks the client's unread portal messages read. Its own params:
 * `comm_channel` and `comm_pages`. Never throws: a failed load shows inside the tab with its Ref.
 */

function first(v: string | string[] | undefined): string | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

function hrefWith(clientId: string, sp: ClientTabProps["searchParams"], patch: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one)
  }
  params.set("tab", "communication")
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) params.delete(k)
    else params.set(k, v)
  }
  return `/clients/${clientId}?${params.toString()}`
}

export default async function ClientCommunicationTab({ clientId, user, supabase, searchParams }: ClientTabProps) {
  const rawChannel = first(searchParams.comm_channel)
  const channel: CommChannelFilter | null = isCommChannelFilter(rawChannel) ? rawChannel : null
  const pages = Math.max(1, Math.min(THREAD_MAX_PAGES, Number.parseInt(first(searchParams.comm_pages) ?? "1", 10) || 1))

  let ref: string | null = null
  let loaded: { thread: Awaited<ReturnType<typeof getThread>>; messaging: Awaited<ReturnType<typeof getMessagingContext>> } | null = null
  try {
    const [thread, messaging] = await Promise.all([getThread(supabase, user, clientId, { channel, pages }), getMessagingContext(supabase, user)])
    loaded = { thread, messaging }
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "client360:communication", userId: user.id, role: user.role, clientId })
  }

  if (!loaded || ref) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load the messages with this client." errorRef={ref} />
      </div>
    )
  }
  const { thread, messaging } = loaded
  if (!thread) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="This client's messages aren't available to you." />
      </div>
    )
  }

  const channelHrefs = {
    all: hrefWith(clientId, searchParams, { comm_channel: null, comm_pages: null }),
    ...Object.fromEntries((Object.keys(COMM_CHANNEL_FILTERS) as CommChannelFilter[]).map((k) => [k, hrefWith(clientId, searchParams, { comm_channel: k, comm_pages: null })])),
  } as Record<CommChannelFilter | "all", string>
  const olderHref = thread.hasOlder && pages < THREAD_MAX_PAGES ? hrefWith(clientId, searchParams, { comm_pages: String(pages + 1) }) : null

  return (
    <section aria-label="Communication" className="overflow-hidden rounded-lg border border-border bg-surface">
      <ClientThread
        client={{
          id: thread.client.id,
          name: thread.client.display_name,
          code: thread.client.client_code,
          onPortal: thread.client.on_portal,
          phone: thread.client.phone,
          whatsapp: thread.client.whatsapp,
        }}
        contacts={thread.contacts}
        messages={thread.messages}
        messaging={{
          firmName: messaging.firmName,
          firmPhone: messaging.firmPhone,
          countryCode: messaging.countryCode,
          signatureFormat: messaging.signatureFormat,
          addSignature: messaging.addSignature,
          senderName: messaging.senderName,
          templates: messaging.templates,
        }}
        portalLink={`${env.appUrl().replace(/\/+$/, "")}/portal`}
        me={user.id}
        today={todayIST()}
        now={new Date().toISOString()}
        newSince={thread.myLastReadAt}
        unreadInbound={thread.unreadInbound}
        seenBy={thread.seenBy}
        channel={channel}
        channelHrefs={channelHrefs}
        olderHref={olderHref}
      />
    </section>
  )
}
