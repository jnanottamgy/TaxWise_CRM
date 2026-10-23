import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { RequestItemStatus, RequestStatus } from "@/lib/domain/enums";
import { profileNames } from "@/lib/data/documents";
import { nextReminderOn, requestProgress, type RequestProgress } from "@/lib/schemas/document-requests";

/**
 * Reads for document requests, the staff side (§7.14 PBC lists, Client 360 → Documents → Requests),
 * under the caller's RLS. A client has few requests, so every request comes with its items; the
 * list is open requests first, then the most recent.
 */

export interface RequestItemRow {
  id: string;
  title: string;
  help_text: string | null;
  is_required: boolean;
  status: RequestItemStatus;
  document_id: string | null;
  document_title: string | null;
  document_file_name: string | null;
  document_mime_type: string | null;
  rejection_reason: string | null;
  sort_order: number;
  uploaded_at: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  updated_at: string;
}

export interface RequestRow {
  id: string;
  title: string;
  status: RequestStatus;
  due_date: string | null;
  notes: string | null;
  reminder_every_days: number;
  reminder_count: number;
  last_reminded_at: string | null;
  contact_id: string | null;
  contact_name: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  items: RequestItemRow[];
  progress: RequestProgress;
  /** The day the 09:00 job sends the next reminder, or null when none is due. */
  next_reminder_on: string | null;
}

export interface RequestFilters {
  status?: RequestStatus | "all";
  limit?: number;
}

/** The client's document requests with their items (open first, newest first). */
export async function listDocumentRequests(supabase: ServerSupabase, clientId: string, f: RequestFilters = {}): Promise<{ rows: RequestRow[]; counts: Record<RequestStatus, number> }> {
  const [list, all] = await Promise.all([
    (() => {
      let q = supabase
        .from("document_requests")
        .select(
          "id, title, status, due_date, notes, reminder_every_days, reminder_count, last_reminded_at, contact_id, created_by, created_at, updated_at, completed_at, cancelled_at, cancel_reason",
        )
        .eq("client_id", clientId);
      if (f.status && f.status !== "all") q = q.eq("status", f.status);
      return q.order("status", { ascending: true }).order("created_at", { ascending: false }).limit(f.limit ?? 100);
    })(),
    supabase.from("document_requests").select("status").eq("client_id", clientId).limit(2000),
  ]);
  if (list.error) throw list.error;
  if (all.error) throw all.error;
  const counts: Record<RequestStatus, number> = { open: 0, completed: 0, cancelled: 0 };
  for (const r of all.data ?? []) counts[r.status] += 1;

  const requests = list.data ?? [];
  if (requests.length === 0) return { rows: [], counts };
  const ids = requests.map((r) => r.id);
  const contactIds = Array.from(new Set(requests.map((r) => r.contact_id).filter((c): c is string => !!c)));
  const [items, contacts] = await Promise.all([
    supabase
      .from("document_request_items")
      .select("id, request_id, title, help_text, is_required, status, document_id, rejection_reason, sort_order, uploaded_at, reviewed_at, reviewed_by, updated_at")
      .in("request_id", ids)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    contactIds.length
      ? supabase.from("client_contacts").select("id, name").in("id", contactIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
  ]);
  if (items.error) throw items.error;
  if (contacts.error) throw contacts.error;
  const itemRows = items.data ?? [];
  const docIds = Array.from(new Set(itemRows.map((i) => i.document_id).filter((d): d is string => !!d)));
  const [docs, names] = await Promise.all([
    docIds.length
      ? supabase.from("documents").select("id, title, file_name, mime_type, deleted_at").in("id", docIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string; file_name: string; mime_type: string; deleted_at: string | null }>, error: null }),
    profileNames(supabase, [...requests.map((r) => r.created_by), ...itemRows.map((i) => i.reviewed_by)]),
  ]);
  if (docs.error) throw docs.error;
  const docMap = new Map((docs.data ?? []).filter((d) => !d.deleted_at).map((d) => [d.id, d] as const));
  const contactMap = new Map((contacts.data ?? []).map((c) => [c.id, c.name] as const));

  const byRequest = new Map<string, RequestItemRow[]>();
  for (const i of itemRows) {
    const doc = i.document_id ? docMap.get(i.document_id) : undefined;
    const list = byRequest.get(i.request_id) ?? [];
    list.push({
      id: i.id,
      title: i.title,
      help_text: i.help_text,
      is_required: i.is_required,
      status: i.status,
      document_id: doc ? i.document_id : null,
      document_title: doc?.title ?? null,
      document_file_name: doc?.file_name ?? null,
      document_mime_type: doc?.mime_type ?? null,
      rejection_reason: i.rejection_reason,
      sort_order: i.sort_order,
      uploaded_at: i.uploaded_at,
      reviewed_at: i.reviewed_at,
      reviewed_by_name: i.reviewed_by ? (names.get(i.reviewed_by) ?? null) : null,
      updated_at: i.updated_at,
    });
    byRequest.set(i.request_id, list);
  }

  const order: Record<RequestStatus, number> = { open: 0, completed: 1, cancelled: 2 };
  const rows: RequestRow[] = requests
    .map((r) => {
      const its = byRequest.get(r.id) ?? [];
      const progress = requestProgress(its);
      return {
        ...r,
        contact_name: r.contact_id ? (contactMap.get(r.contact_id) ?? null) : null,
        created_by_name: names.get(r.created_by) ?? null,
        items: its,
        progress,
        next_reminder_on: nextReminderOn({
          status: r.status,
          lastRemindedAt: r.last_reminded_at,
          createdAt: r.created_at,
          everyDays: r.reminder_every_days,
          outstanding: progress.outstanding,
        }),
      };
    })
    .sort((a, b) => order[a.status] - order[b.status] || b.created_at.localeCompare(a.created_at));
  return { rows, counts };
}

export interface RequestContact {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  email_bounced: boolean;
  phone: string | null;
  whatsapp: string | null;
  is_primary: boolean;
}

export interface RequestContext {
  contacts: RequestContact[];
  /** Settings → Reminders: the default cadence (§5.2 document_request_reminder_every_days). */
  defaultEveryDays: number;
  client: { id: string; display_name: string; client_code: string; phone: string | null; whatsapp: string | null; email: string | null; has_portal: boolean };
}

/** What the request dialog and the hand-offs need: the client's contacts, the default cadence, the client. */
export async function getRequestContext(supabase: ServerSupabase, clientId: string): Promise<RequestContext | null> {
  const [client, contacts, settings] = await Promise.all([
    supabase.from("clients").select("id, display_name, client_code, phone, whatsapp, email, portal_user_id, deleted_at").eq("id", clientId).maybeSingle(),
    supabase
      .from("client_contacts")
      .select("id, name, role, email, email_bounced, phone, whatsapp, is_primary")
      .eq("client_id", clientId)
      .order("is_primary", { ascending: false })
      .order("name", { ascending: true })
      .limit(50),
    supabase.from("firm_settings").select("document_request_reminder_every_days").eq("id", 1).maybeSingle(),
  ]);
  if (client.error) throw client.error;
  if (contacts.error) throw contacts.error;
  if (settings.error) throw settings.error;
  if (!client.data || client.data.deleted_at) return null;
  return {
    contacts: (contacts.data ?? []).map((c) => ({ ...c, email: c.email ? String(c.email) : null, email_bounced: Boolean(c.email_bounced) })),
    defaultEveryDays: settings.data?.document_request_reminder_every_days ?? 3,
    client: {
      id: client.data.id,
      display_name: client.data.display_name,
      client_code: String(client.data.client_code),
      phone: client.data.phone,
      whatsapp: client.data.whatsapp,
      email: client.data.email ? String(client.data.email) : null,
      has_portal: Boolean(client.data.portal_user_id),
    },
  };
}
