import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { TemplateType } from "@/lib/domain/enums";
import { escapeLike, type TableParams } from "@/components/app/data-table/params";
import { MONEY_TEMPLATE_TYPES, type TemplateChannel } from "@/lib/schemas/message-templates";
import { getNamesByProfile } from "@/lib/data/people";

/**
 * Message templates (§5.9, §7.13.4), read under the caller's RLS: Partners and Managers see every
 * template; Employees ("use only", §4.1) see the active ones that aren't about money (0170). Search,
 * filters, sort and paging run in SQL (§2.3).
 */

export type MessageTemplateRow = {
  id: string;
  name: string;
  type: TemplateType;
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /** Who added it; null for the firm's seeded defaults (§16). */
  created_by_name: string | null;
  updated_by_name: string | null;
};

const COLS = "id, name, type, channel, subject, body, is_active, created_by, updated_by, created_at, updated_at";

type RawRow = Omit<MessageTemplateRow, "created_by_name" | "updated_by_name" | "name" | "channel"> & { name: string; channel: string };

function orSafe(q: string): string {
  return q.replace(/[,()"\\]/g, " ").replace(/\s+/g, " ").trim();
}

async function decorate(supabase: ServerSupabase, rows: RawRow[]): Promise<MessageTemplateRow[]> {
  const names = await getNamesByProfile(supabase, rows.flatMap((r) => [r.created_by, r.updated_by]));
  return rows.map((r) => ({
    ...r,
    name: String(r.name),
    channel: (r.channel === "email" || r.channel === "whatsapp" ? r.channel : "any") as TemplateChannel,
    created_by_name: r.created_by ? (names.get(r.created_by) ?? null) : null,
    updated_by_name: r.updated_by ? (names.get(r.updated_by) ?? null) : null,
  }));
}

export async function listMessageTemplates(
  supabase: ServerSupabase,
  user: Pick<CurrentUser, "role">,
  t: TableParams<string, string>,
): Promise<{ rows: MessageTemplateRow[]; total: number }> {
  const seesMoney = user.role === "partner" || user.role === "manager";
  let q = supabase.from("message_templates").select(COLS, { count: "exact" });
  if (!seesMoney) q = q.not("type", "in", `(${MONEY_TEMPLATE_TYPES.join(",")})`).eq("is_active", true);

  const search = orSafe(t.q);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    q = q.or(`name.ilike.${like},subject.ilike.${like},body.ilike.${like}`);
  }
  const types = (t.filters.type ?? []).filter((x) => seesMoney || !(MONEY_TEMPLATE_TYPES as readonly string[]).includes(x));
  if (t.filters.type && types.length === 0) return { rows: [], total: 0 };
  if (types.length) q = q.in("type", types as TemplateType[]);
  if (t.filters.channel?.length) q = q.in("channel", t.filters.channel);
  const state = t.filters.state ?? [];
  if (seesMoney && state.length === 1) q = q.eq("is_active", state[0] === "active");

  const sort = t.sort ?? "name";
  q = q.order(sort, { ascending: t.dir === "asc" });
  if (sort !== "name") q = q.order("name", { ascending: true });
  q = q.range(t.from, t.to);

  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: await decorate(supabase, (data ?? []) as RawRow[]), total: count ?? 0 };
}

/** One template (under RLS: null when it doesn't exist or the caller may not see it). */
export async function getMessageTemplate(supabase: ServerSupabase, id: string): Promise<MessageTemplateRow | null> {
  const { data, error } = await supabase.from("message_templates").select(COLS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await decorate(supabase, [data as RawRow]))[0] ?? null;
}

/** How many templates are active and inactive (the page's tally line), under the caller's RLS. */
export async function countTemplatesByState(supabase: ServerSupabase): Promise<{ active: number; inactive: number }> {
  const [active, inactive] = await Promise.all([
    supabase.from("message_templates").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("message_templates").select("id", { count: "exact", head: true }).eq("is_active", false),
  ]);
  if (active.error) throw active.error;
  if (inactive.error) throw inactive.error;
  return { active: active.count ?? 0, inactive: inactive.count ?? 0 };
}

/** The firm details the preview fills in (§7.13.4 "Preview renders with a sample client"). */
export async function getTemplatePreviewContext(supabase: ServerSupabase): Promise<{ firmName: string; firmPhone: string | null; signatureFormat: string }> {
  const { data, error } = await supabase.from("firm_settings").select("firm_name, phone, whatsapp_signature").eq("id", 1).maybeSingle();
  if (error) throw error;
  return {
    firmName: data?.firm_name ?? "TaxWise Consultants",
    firmPhone: data?.phone ?? null,
    signatureFormat: data?.whatsapp_signature ?? "– {first_name}",
  };
}
