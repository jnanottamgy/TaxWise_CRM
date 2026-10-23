import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ArrowLeftIcon, ExternalLinkIcon, MessagesSquareIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { requireStaff } from "@/lib/auth/guards"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { applyTablePatch, hasActiveFilters, parseTableParams, readParam, type SearchParamsInput } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { EmptyState } from "@/components/app/empty-state"
import { PageGuide } from "@/components/shell/page-slots"
import { Button } from "@/components/ui/button"
import { COMM_CHANNEL_FILTERS, THREAD_FILTERS, THREAD_FILTER_NAMES, THREAD_MAX_PAGES, isCommChannelFilter, type CommChannelFilter } from "@/lib/schemas/inbox"
import { isMoneyTemplateType } from "@/lib/schemas/message-templates"
import { getMessagingContext } from "@/lib/data/clients"
import { getThread, listThreads } from "@/lib/data/threads"
import { ThreadsList } from "@/components/comms/threads-list"
import { ClientThread } from "@/components/comms/client-thread"
import { BulkReminderBuilder } from "@/components/bulk-queue/bulk-reminder-builder"

export const metadata: Metadata = { title: "Messages" }

type SearchParams = Record<string, string | string[] | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/messages:${source}`, userId }) }
  }
}

function href(sp: SearchParamsInput, patch: Record<string, string | null>): string {
  const params = new URLSearchParams(applyTablePatch(sp, {}))
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return qs ? `/messages?${qs}` : "/messages"
}

/**
 * Messages (§7.13.1; nav "Messages"): "Which clients are waiting on a reply from us?" One
 * conversation per client across email, WhatsApp and Gmail hand-offs, the portal and calls, unread
 * first. Employees see only their own clients (and clients they cover), and never a message about
 * money (RLS). Choosing a conversation opens it beside the list, where you can reply on the portal,
 * hand off to WhatsApp or Gmail, or log a call; "Bulk reminders" builds a WhatsApp queue (§7.13.2).
 */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const t = parseTableParams(sp, { sortable: [], filters: THREAD_FILTERS })
  const rawClient = readParam(sp, "client")
  const clientId = rawClient && UUID.test(rawClient) ? rawClient : null
  const rawChannel = readParam(sp, "channel")
  const channel: CommChannelFilter | null = isCommChannelFilter(rawChannel) ? rawChannel : null
  const pages = Math.max(1, Math.min(THREAD_MAX_PAGES, Number.parseInt(readParam(sp, "older") ?? "1", 10) || 1))
  const canFilterMine = user.role !== "employee"

  const [list, messaging, thread] = await Promise.all([
    attempt("threads", user.id, () => listThreads(supabase, user, t)),
    attempt("messaging", user.id, () => getMessagingContext(supabase, user)),
    clientId ? attempt("thread", user.id, () => getThread(supabase, user, clientId, { channel, pages })) : Promise.resolve(null),
  ])

  const listHrefs: Record<string, string> = {}
  if (list.ok) for (const r of list.data.rows) listHrefs[r.client_id] = href(sp, { client: r.client_id, channel: null, older: null })
  const builderTemplates = messaging.ok
    ? messaging.data.templates.filter((tpl) => (tpl.channel === "whatsapp" || tpl.channel === "any") && !isMoneyTemplateType(tpl.type)).map((tpl) => ({ id: tpl.id, name: tpl.name, type: tpl.type }))
    : []
  const selected = thread && thread.ok ? thread.data : null
  const channelHrefs = {
    all: href(sp, { channel: null, older: null }),
    ...Object.fromEntries((Object.keys(COMM_CHANNEL_FILTERS) as CommChannelFilter[]).map((k) => [k, href(sp, { channel: k, older: null })])),
  } as Record<CommChannelFilter | "all", string>

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Messages">
        <p>One conversation per client: emails, WhatsApp and Gmail hand-offs, portal messages, and the calls and notes your team logs. Clients with portal messages nobody has read come first.</p>
        <p className="mt-2">A WhatsApp or Gmail message is recorded as handed off: the app opens WhatsApp or Gmail with the draft and you press Send there. Portal replies go straight to the client&apos;s portal.</p>
        <p className="mt-2">Bulk reminders drafts a WhatsApp message for every client in a list (data awaited, returns due soon, pending documents) and walks you through them one by one.</p>
      </PageGuide>
      <PageHeader
        title="Messages"
        description={user.role === "employee" ? "Conversations with your clients, across every channel." : "Conversations with clients across email, WhatsApp, Gmail, the portal and calls."}
        actions={<BulkReminderBuilder templates={builderTemplates} canFilterMine={canFilterMine} />}
      />
      <FilterBar
        searchLabel="Search conversations"
        searchPlaceholder="Client name or code"
        filters={[
          { id: "unread", label: "Unread", multi: false, options: [{ value: "1", label: "Unread from clients" }] },
          ...(canFilterMine ? [{ id: "mine", label: "Clients", multi: false, options: [{ value: "1", label: "My clients" }] }] : []),
        ]}
      />

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <section aria-label="Conversations" className={cn("min-w-0 self-start overflow-hidden rounded-lg border border-border bg-surface", clientId && "max-lg:hidden")}>
          {list.ok ? (
            <ThreadsList
              rows={list.data.rows}
              total={list.data.total}
              page={t.page}
              pageSize={t.pageSize}
              selectedId={clientId}
              hrefFor={listHrefs}
              filtered={hasActiveFilters(sp, THREAD_FILTER_NAMES)}
              canFilterMine={canFilterMine}
            />
          ) : (
            <ErrorBlock message="Couldn't load the conversations." errorRef={list.ref} />
          )}
        </section>

        <section aria-label="Conversation" className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-surface", !clientId && "max-lg:hidden")}>
          {!clientId ? (
            <EmptyState icon={<MessagesSquareIcon />} message="Choose a conversation to read it and reply." />
          ) : thread && !thread.ok ? (
            <ErrorBlock message="Couldn't load this conversation." errorRef={thread.ref} />
          ) : !selected ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <p className="text-base text-text">This conversation isn&apos;t available to you. It may belong to a client you don&apos;t look after.</p>
              <Button asChild variant="outline" size="sm">
                <Link href={href(sp, { client: null, channel: null, older: null })}>Back to all conversations</Link>
              </Button>
            </div>
          ) : !messaging.ok ? (
            <ErrorBlock message="Couldn't load the templates and firm details for replying." errorRef={messaging.ref} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5 md:px-5">
                <div className="flex min-w-0 items-center gap-2">
                  <Link
                    href={href(sp, { client: null, channel: null, older: null })}
                    aria-label="Back to all conversations"
                    className="inline-flex size-8 flex-none items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden pointer-coarse:size-11"
                  >
                    <ArrowLeftIcon aria-hidden="true" className="size-4" />
                  </Link>
                  <div className="min-w-0">
                    <h2 className="truncate text-md leading-6 font-semibold text-text">{selected.client.display_name}</h2>
                    <p className="truncate text-sm text-text-muted">
                      {selected.client.client_code}
                      {selected.client.owner_name ? ` · owner ${selected.client.owner_name}` : ""}
                      {selected.client.on_portal ? " · on the portal" : " · not on the portal"}
                    </p>
                  </div>
                </div>
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/clients/${selected.client.id}?tab=communication`}>
                    <ExternalLinkIcon aria-hidden="true" />
                    Client 360
                  </Link>
                </Button>
              </div>
              <ClientThread
                key={selected.client.id}
                client={{
                  id: selected.client.id,
                  name: selected.client.display_name,
                  code: selected.client.client_code,
                  onPortal: selected.client.on_portal,
                  email: selected.client.email,
                  phone: selected.client.phone,
                  whatsapp: selected.client.whatsapp,
                }}
                contacts={selected.contacts}
                messages={selected.messages}
                messaging={{
                  firmName: messaging.data.firmName,
                  firmPhone: messaging.data.firmPhone,
                  countryCode: messaging.data.countryCode,
                  signatureFormat: messaging.data.signatureFormat,
                  addSignature: messaging.data.addSignature,
                  senderName: messaging.data.senderName,
                  templates: messaging.data.templates,
                }}
                portalLink={`${env.appUrl().replace(/\/+$/, "")}/portal`}
                me={user.id}
                today={todayIST()}
                newSince={selected.myLastReadAt}
                unreadInbound={selected.unreadInbound}
                seenBy={selected.seenBy}
                channel={channel}
                channelHrefs={channelHrefs}
                olderHref={selected.hasOlder && pages < THREAD_MAX_PAGES ? href(sp, { older: String(pages + 1) }) : null}
                frameClassName="max-h-[min(48dvh,36rem)]"
              />
            </>
          )}
        </section>
      </div>
    </div>
  )
}
