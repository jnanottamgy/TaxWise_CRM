import "server-only";

import type { Enums } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import { escapeLike } from "@/components/app/data-table/params";
import { readRecurringConfig, type RecurringConfig, type RecurringFrequency, RECURRING_FREQUENCIES } from "@/lib/schemas/job-templates";

/**
 * Reads for job templates and recurring tasks (§7.6.2, §7.6.7). Every staff member may read
 * templates (Employees use them, §4.1); recurring-task automations are Partner/Manager only (RLS,
 * 0035), so an Employee's read simply returns nothing.
 */

export type JobTemplateRow = {
  id: string;
  name: string;
  service_type: Enums<"service_type">;
  description: string | null;
  default_lead_days: number | null;
  is_active: boolean;
  steps: number;
  used: number;
  updated_at: string;
};

export async function listJobTemplates(
  supabase: ServerSupabase,
  opts: { q?: string; service?: readonly string[]; state?: "active" | "inactive" | null } = {},
): Promise<JobTemplateRow[]> {
  let q = supabase
    .from("job_templates")
    .select("id, name, service_type, description, default_lead_days, is_active, updated_at, job_template_items(count), tasks!tasks_source_template_id_fkey(count)")
    .order("is_active", { ascending: false })
    .order("name")
    .limit(500);
  const s = (opts.q ?? "").replace(/[,()"\\]/g, " ").trim();
  if (s) q = q.or(`name.ilike.%${escapeLike(s)}%,description.ilike.%${escapeLike(s)}%`);
  if (opts.service?.length) q = q.in("service_type", opts.service as Enums<"service_type">[]);
  if (opts.state === "active") q = q.eq("is_active", true);
  else if (opts.state === "inactive") q = q.eq("is_active", false);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((t) => ({
    id: t.id,
    name: String(t.name),
    service_type: t.service_type,
    description: t.description,
    default_lead_days: t.default_lead_days,
    is_active: t.is_active,
    steps: (t.job_template_items as unknown as Array<{ count: number }> | null)?.[0]?.count ?? 0,
    used: (t.tasks as unknown as Array<{ count: number }> | null)?.[0]?.count ?? 0,
    updated_at: t.updated_at,
  }));
}

/** Templates with their steps (one query for the steps), for the templates page. */
export async function listJobTemplatesWithItems(
  supabase: ServerSupabase,
  opts: Parameters<typeof listJobTemplates>[1] = {},
): Promise<Array<JobTemplateRow & { items: Array<{ id: string; title: string; description: string | null; offset_days: number }> }>> {
  const templates = await listJobTemplates(supabase, opts)
  if (!templates.length) return []
  const { data, error } = await supabase
    .from("job_template_items")
    .select("id, template_id, title, description, offset_days, sort_order, created_at")
    .in("template_id", templates.map((t) => t.id))
    .order("sort_order")
    .order("created_at")
    .limit(5000)
  if (error) throw error
  const byTemplate = new Map<string, Array<{ id: string; title: string; description: string | null; offset_days: number }>>()
  for (const i of data ?? []) {
    const list = byTemplate.get(i.template_id) ?? []
    list.push({ id: i.id, title: i.title, description: i.description, offset_days: i.offset_days })
    byTemplate.set(i.template_id, list)
  }
  return templates.map((t) => ({ ...t, items: byTemplate.get(t.id) ?? [] }))
}

export type JobTemplateDetail = Omit<JobTemplateRow, "steps" | "used"> & {
  items: Array<{ id: string; title: string; description: string | null; offset_days: number; sort_order: number }>;
};

export async function getJobTemplate(supabase: ServerSupabase, id: string): Promise<JobTemplateDetail | null> {
  const { data, error } = await supabase
    .from("job_templates")
    .select("id, name, service_type, description, default_lead_days, is_active, updated_at, job_template_items(id, title, description, offset_days, sort_order, created_at)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const items = ((data.job_template_items ?? []) as Array<{ id: string; title: string; description: string | null; offset_days: number; sort_order: number; created_at: string }>)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map(({ id: itemId, title, description, offset_days, sort_order }) => ({ id: itemId, title, description, offset_days, sort_order }));
  return {
    id: data.id,
    name: String(data.name),
    service_type: data.service_type,
    description: data.description,
    default_lead_days: data.default_lead_days,
    is_active: data.is_active,
    updated_at: data.updated_at,
    items,
  };
}

export type AutomationRow = {
  id: string;
  client_id: string;
  client_name: string | null;
  client_code: string | null;
  frequency: RecurringFrequency;
  config: RecurringConfig;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  tasks_created: number;
  assignee_name: string | null;
  template_name: string | null;
  updated_at: string;
};

/** Recurring-task automations, optionally for one client (Partners and Managers). */
export async function listAutomations(supabase: ServerSupabase, opts: { clientId?: string | null } = {}): Promise<AutomationRow[]> {
  let q = supabase
    .from("task_automations")
    .select("id, client_id, frequency, config, is_active, next_run_at, last_run_at, updated_at, clients(display_name, client_code), tasks!tasks_automation_id_fkey(count)")
    .eq("type", "recurring_task")
    .order("is_active", { ascending: false })
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .limit(500);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []).flatMap((a) => {
    const config = readRecurringConfig(a.config);
    if (!config || !a.client_id || !(RECURRING_FREQUENCIES as readonly string[]).includes(a.frequency)) return [];
    const c = a.clients as { display_name: string; client_code: string } | null;
    return [
      {
        id: a.id,
        client_id: a.client_id,
        client_name: c?.display_name ?? null,
        client_code: c ? String(c.client_code) : null,
        frequency: a.frequency as RecurringFrequency,
        config,
        is_active: a.is_active,
        next_run_at: a.next_run_at,
        last_run_at: a.last_run_at,
        tasks_created: (a.tasks as unknown as Array<{ count: number }> | null)?.[0]?.count ?? 0,
        assignee_name: null as string | null,
        template_name: null as string | null,
        updated_at: a.updated_at,
      },
    ];
  });
  const people = [...new Set(rows.map((r) => r.config.assignee_employee_id).filter((v): v is string => Boolean(v)))];
  const templates = [...new Set(rows.map((r) => r.config.job_template_id).filter((v): v is string => Boolean(v)))];
  const [names, tpl] = await Promise.all([
    people.length ? supabase.from("employee_directory").select("id, full_name").in("id", people) : Promise.resolve({ data: [], error: null }),
    templates.length ? supabase.from("job_templates").select("id, name").in("id", templates) : Promise.resolve({ data: [], error: null }),
  ]);
  if (names.error) throw names.error;
  if (tpl.error) throw tpl.error;
  const nameMap = new Map(((names.data ?? []) as Array<{ id: string | null; full_name: string | null }>).map((n) => [n.id ?? "", n.full_name]));
  const tplMap = new Map(((tpl.data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, String(t.name)]));
  for (const r of rows) {
    r.assignee_name = r.config.assignee_employee_id ? (nameMap.get(r.config.assignee_employee_id) ?? null) : null;
    r.template_name = r.config.job_template_id ? (tplMap.get(r.config.job_template_id) ?? null) : null;
  }
  return rows;
}
