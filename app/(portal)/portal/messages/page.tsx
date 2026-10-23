import type { Metadata } from "next"
import Link from "next/link"
import { requireClient } from "@/lib/auth/guards"
import { getFirmContact, getLatestFromFirm, getPortalClient, listThread } from "@/lib/data/portal"
import { readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { attempt } from "@/components/portal/load"
import { NotLinked, PortalBlockError } from "@/components/portal/portal-ui"
import { MessageThread } from "@/components/portal/message-thread"

export const metadata: Metadata = { title: "Messages" }

const PAGE = 40

/**
 * Messages (§7.22): the thread with the firm, attachments allowed, with read receipts both ways:
 * opening this page marks the firm's messages read, and the client sees when the firm has read
 * theirs. Staff reply from the Client 360 Communication tab. Only the portal channel is shown,
 * never WhatsApp, email hand-offs or internal notes (portal_messages, 0175).
 */
export default async function PortalMessagesPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireClient()
  const sp = await props.searchParams
  const beforeRaw = readParam(sp, "before")
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw).toISOString() : null

  const client = await attempt("messages:client", user.id, () => getPortalClient(supabase))
  if (client.ok && !client.data) {
    return (
      <div className="flex min-w-0 flex-col">
        <PageHeader title="Messages" />
        <NotLinked />
      </div>
    )
  }

  const [thread, unread, firm] = await Promise.all([
    attempt("messages:thread", user.id, () => listThread(supabase, { limit: PAGE, before })),
    attempt("messages:unread", user.id, () => getLatestFromFirm(supabase, 0)),
    attempt("messages:firm", user.id, () => getFirmContact(supabase)),
  ])
  const firmName = firm.ok ? firm.data.firmName : "the firm"
  const owner = client.ok && client.data ? client.data.owner : null

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader
        title="Messages"
        description={owner ? `Your thread with ${firmName}. ${owner.name} and the team reply here.` : `Your thread with ${firmName}.`}
        actions={
          before ? (
            <Link href="/portal/messages" className="text-sm font-medium text-primary hover:underline">
              Back to the latest
            </Link>
          ) : undefined
        }
      />
      {!thread.ok ? (
        <PortalBlockError title="Messages" message="Couldn't load your messages." errorRef={thread.ref} />
      ) : !client.ok || !client.data ? (
        <PortalBlockError title="Messages" message="Couldn't load your client file, so messages can't be sent." errorRef={client.ok ? "" : client.ref} />
      ) : (
        <MessageThread
          messages={thread.data.messages}
          hasEarlier={thread.data.hasEarlier}
          earlierHref={thread.data.hasEarlier && thread.data.messages[0] ? `/portal/messages?before=${encodeURIComponent(thread.data.messages[0].createdAt)}` : null}
          atLatest={before === null}
          firmName={firmName}
          clientId={client.data.id}
          ownerName={owner?.name ?? null}
          unreadFromFirm={unread.ok ? unread.data.unread : 0}
        />
      )}
    </div>
  )
}
