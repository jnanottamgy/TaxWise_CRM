import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { ServiceType } from "@/lib/domain/enums";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { getNamesByProfile } from "@/lib/data/people";
import { COMM_CHANNEL_FILTERS, THREAD_MAX_PAGES, THREAD_PAGE, type CommChannelFilter, type ThreadMessage } from "@/lib/schemas/inbox";

/**
 * Staff message threads (§7.13.1, /messages, Client 360 → Communication), read under the caller's
 * RLS: an Employee reaches only the clients they can see, and never a message about fees,
 * invoices or quotations (0043); a Partner or Manager reaches every client. One thread per client:
 * every channel (email, WhatsApp and Gmail hand-offs, portal, calls and notes) in one history.
 */

// -------------------------------------------------------------------------------------------------
// The list of threads (message_threads, 0173)
// -------------------------------------------------------------------------------------------------

export type ThreadListRow = {
  client_id: string;
  client_name: string;
  client_code: string;
  client_status: string;
  on_portal: boolean;
  last_channel: string;
  last_direction: "inbound" | "outbound";
  last_status: string;
  last_subject: string | null;
  last_preview: string;
  last_at: string;
  last_sender_name: string | null;
  unread_count: number;
  has_unread: boolean;
  new_for_me: boolean;
};

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Clients the person owns or is on the team of ("My clients"). */
export async function myClientIds(supabase: ServerSupabase, employeeId: string): Promise<string[]> {
  const [owned, team] = await Promise.all([
    supabase.from("clients").select("id").eq("owner_employee_id", employeeId).is("deleted_at", null).limit(2000),
    supabase.from("client_team_members").select("client_id").eq("employee_id", employeeId).limit(2000),
  ]);
  if (owned.error) throw owned.error;
  if (team.error) throw team.error;
  return Array.from(new Set([...(owned.data ?? []).map((c) => c.id), ...(team.data ?? []).map((t) => t.client_id)]));
}

/** Threads, unread first, then the most recent (§7.13.1 /messages). */
export async function listThreads(
  supabase: ServerSupabase,
  user: Pick<CurrentUser, "role" | "employeeId">,
  t: TableParams<string, string>,
): Promise<{ rows: ThreadListRow[]; total: number }> {
  let q = supabase
    .from("message_threads")
    .select("client_id, client_name, client_code, client_status, on_portal, last_channel, last_direction, last_status, last_subject, last_preview, last_at, last_sent_by, unread_count, has_unread, new_for_me", { count: "exact" });
  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(`client_name.ilike.${like},client_code.ilike.${like}`);
  }
  if (t.filters.unread?.length) q = q.eq("has_unread", true);
  if (t.filters.mine?.length && user.role !== "employee") {
    const ids = user.employeeId ? (await myClientIds(supabase, user.employeeId)).slice(0, 500) : [];
    if (ids.length === 0) return { rows: [], total: 0 };
    q = q.in("client_id", ids);
  }
  q = q.order("has_unread", { ascending: false }).order("last_at", { ascending: false }).order("client_id", { ascending: true });
  const { data, error, count } = await q.range(t.from, t.to);
  if (error) throw error;
  const raw = (data ?? []).filter((r) => r.client_id && r.last_at);
  const names = await getNamesByProfile(supabase, raw.map((r) => r.last_sent_by));
  return {
    rows: raw.map((r) => ({
      client_id: r.client_id as string,
      client_name: r.client_name ?? "Client",
      client_code: r.client_code ?? "",
      client_status: r.client_status ?? "active",
      on_portal: Boolean(r.on_portal),
      last_channel: r.last_channel ?? "internal_note",
      last_direction: r.last_direction === "inbound" ? "inbound" : "outbound",
      last_status: r.last_status ?? "sent",
      last_subject: r.last_subject ?? null,
      last_preview: r.last_preview ?? "",
      last_at: r.last_at as string,
      last_sender_name: r.last_direction === "inbound" ? null : r.last_sent_by ? (names.get(r.last_sent_by) ?? null) : null,
      unread_count: r.unread_count ?? 0,
      has_unread: Boolean(r.has_unread),
      new_for_me: Boolean(r.new_for_me),
    })),
    total: count ?? 0,
  };
}

// -------------------------------------------------------------------------------------------------
// One thread
// -------------------------------------------------------------------------------------------------

export type ThreadContact = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  email_bounced: boolean;
  phone: string | null;
  whatsapp: string | null;
  is_primary: boolean;
  handles: ServiceType[];
};

export type ThreadClient = {
  id: string;
  display_name: string;
  client_code: string;
  status: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  on_portal: boolean;
  owner_name: string | null;
};

export type Thread = {
  client: ThreadClient;
  contacts: ThreadContact[];
  /** Oldest first within the loaded window. */
  messages: ThreadMessage[];
  hasOlder: boolean;
  pages: number;
  /** Portal messages from the client nobody at the firm has read. */
  unreadInbound: number;
  /** When the signed-in person last opened this thread (before this visit). */
  myLastReadAt: string | null;
  /** Colleagues who opened it, most recent first. */
  seenBy: Array<{ name: string; at: string }>;
};

const MESSAGE_COLS =
  "id, channel, direction, status, subject, body, recipient, sent_at, created_at, sent_by, contact_id, template_id, related_entity_type, read_at, delivered_at, failed_at, error";

type RawMessage = {
  id: string;
  channel: string;
  direction: "inbound" | "outbound";
  status: string;
  subject: string | null;
  body: string;
  recipient: string | null;
  sent_at: string | null;
  created_at: string;
  sent_by: string | null;
  contact_id: string | null;
  template_id: string | null;
  related_entity_type: string | null;
  read_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  error: string | null;
};

/**
 * A client's thread: the latest `pages × THREAD_PAGE` messages (optionally one channel group), the
 * contacts the composer can write to, and who has read it. Null when the caller can't see the client
 * (RLS) or it is in the recycle bin.
 */
export async function getThread(
  supabase: ServerSupabase,
  user: Pick<CurrentUser, "id">,
  clientId: string,
  opts: { channel?: CommChannelFilter | null; pages?: number } = {},
): Promise<Thread | null> {
  const pages = Math.max(1, Math.min(THREAD_MAX_PAGES, Math.trunc(opts.pages ?? 1)));
  const limit = pages * THREAD_PAGE;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, display_name, client_code, status, email, phone, whatsapp, portal_user_id, owner_employee_id, deleted_at")
    .eq("id", clientId)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!client || client.deleted_at) return null;

  let mq = supabase.from("messages").select(MESSAGE_COLS).eq("client_id", clientId);
  if (opts.channel) mq = mq.in("channel", [...COMM_CHANNEL_FILTERS[opts.channel].channels]);
  mq = mq.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);

  const [contacts, messages, reads, unread, owner] = await Promise.all([
    supabase.from("client_contacts").select("id, name, role, email, email_bounced, phone, whatsapp, is_primary, handles").eq("client_id", clientId).order("is_primary", { ascending: false }).order("name"),
    mq,
    supabase.from("message_thread_reads").select("user_id, last_read_at").eq("client_id", clientId).order("last_read_at", { ascending: false }).limit(20),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("channel", "portal").eq("direction", "inbound").is("read_at", null),
    client.owner_employee_id
      ? supabase.from("employee_directory").select("full_name").eq("id", client.owner_employee_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [contacts, messages, reads, unread, owner]) if (r.error) throw r.error;

  const raw = (messages.data ?? []) as RawMessage[];
  const hasOlder = raw.length > limit;
  const window = raw.slice(0, limit).reverse();
  const contactRows = (contacts.data ?? []) as Array<ThreadContact & { email: string | null }>;
  const contactName = new Map(contactRows.map((c) => [c.id, c.name]));

  const messageIds = window.map((m) => m.id);
  const templateIds = Array.from(new Set(window.map((m) => m.template_id).filter((v): v is string => !!v)));
  const [attachments, templates, names] = await Promise.all([
    messageIds.length
      ? supabase.from("message_attachments").select("message_id, document_id, documents(title)").in("message_id", messageIds)
      : Promise.resolve({ data: [], error: null }),
    templateIds.length ? supabase.from("message_templates").select("id, name").in("id", templateIds) : Promise.resolve({ data: [], error: null }),
    getNamesByProfile(supabase, [...window.map((m) => m.sent_by), ...(reads.data ?? []).map((r) => r.user_id)]),
  ]);
  if (attachments.error) throw attachments.error;
  if (templates.error) throw templates.error;

  const files = new Map<string, Array<{ id: string; title: string }>>();
  for (const a of (attachments.data ?? []) as Array<{ message_id: string; document_id: string; documents: { title: string } | null }>) {
    files.set(a.message_id, [...(files.get(a.message_id) ?? []), { id: a.document_id, title: a.documents?.title ?? "Document" }]);
  }
  const templateName = new Map(((templates.data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, String(t.name)]));

  const myRead = (reads.data ?? []).find((r) => r.user_id === user.id);
  return {
    client: {
      id: client.id,
      display_name: client.display_name,
      client_code: String(client.client_code),
      status: client.status,
      email: client.email ?? null,
      phone: client.phone ?? null,
      whatsapp: client.whatsapp ?? null,
      on_portal: Boolean(client.portal_user_id),
      owner_name: (owner.data as { full_name: string | null } | null)?.full_name ?? null,
    },
    contacts: contactRows.map((c) => ({ ...c, email: c.email ? String(c.email) : null, handles: (c.handles ?? []) as ServiceType[] })),
    messages: window.map((m) => ({
      id: m.id,
      channel: m.channel,
      direction: m.direction,
      status: m.status,
      subject: m.subject,
      body: m.body,
      recipient: m.recipient,
      at: m.sent_at ?? m.created_at,
      created_at: m.created_at,
      sent_by: m.sent_by,
      sender_name: m.direction === "inbound" && m.channel === "portal" ? null : m.sent_by ? (names.get(m.sent_by) ?? null) : null,
      contact_name: m.contact_id ? (contactName.get(m.contact_id) ?? null) : null,
      template_name: m.template_id ? (templateName.get(m.template_id) ?? null) : null,
      related_entity_type: m.related_entity_type,
      read_at: m.read_at,
      delivered_at: m.delivered_at,
      failed_at: m.failed_at,
      error: m.error,
      attachments: files.get(m.id) ?? [],
    })),
    hasOlder,
    pages,
    unreadInbound: unread.count ?? 0,
    myLastReadAt: myRead?.last_read_at ?? null,
    seenBy: (reads.data ?? [])
      .filter((r) => r.user_id !== user.id)
      .map((r) => ({ name: names.get(r.user_id) ?? "A colleague", at: r.last_read_at }))
      .slice(0, 6),
  };
}
