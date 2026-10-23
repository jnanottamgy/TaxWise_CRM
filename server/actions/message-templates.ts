"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { formatDateTime } from "@/lib/format";
import { MessageTemplateSchema, SetTemplateActiveSchema, TemplateIdSchema, copyName, usedVariables } from "@/lib/schemas/message-templates";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Message templates (§5.9, §7.13.4; §4.1 "Job templates, message templates: Partner ✅ Manager ✅
 * Employee use only"). Partners and Managers create, edit, copy, switch off and delete them; RLS
 * (0038, 0170) refuses everyone else. The variables are checked on save twice: here with the shared
 * schema (validateTemplate names the field and the offending variables) and in the database
 * (message_templates_guard). Edits carry the row's updated_at (§13). Every change is audited.
 */

const PM = ["partner", "manager"] as const;
const DUPLICATE_NAME = "A template with this name already exists. Give it another name.";

/** "Changed by Ravi at 22 Oct 2026, 12:41. Reload to see their changes." */
async function conflictMessage(supabase: ServerSupabase, id: string): Promise<{ message: string; code: "conflict" | "not_found" }> {
  const { data } = await supabase.from("message_templates").select("updated_at, updated_by").eq("id", id).maybeSingle();
  if (!data) return { message: "That template no longer exists.", code: "not_found" };
  let who = "someone else";
  if (data.updated_by) {
    const { data: person } = await supabase.from("employee_directory").select("full_name").eq("profile_id", data.updated_by).maybeSingle();
    if (person?.full_name) who = person.full_name;
  }
  return { message: `Changed by ${who} at ${formatDateTime(data.updated_at)}. Reload to see their changes.`, code: "conflict" };
}

export const saveMessageTemplate = defineAction(
  { name: "message_templates.save", schema: MessageTemplateSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; updated_at: string }>> => {
    const row = {
      name: input.name,
      type: input.type,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      is_active: input.is_active,
    };

    if (input.id) {
      if (!input.expected_updated_at) throw new ActionError("Reload the template before saving it.", { code: "conflict" });
      const { data, error } = await ctx.supabase
        .from("message_templates")
        .update(row)
        .eq("id", input.id)
        .eq("updated_at", input.expected_updated_at)
        .select("id, updated_at");
      throwIfDbError(error, { uniqueField: "name", uniqueMessage: DUPLICATE_NAME });
      if (!data || data.length === 0) {
        const c = await conflictMessage(ctx.supabase, input.id);
        return fail(c.message, { code: c.code });
      }
      await ctx.audit({
        event: "data_update",
        resourceType: "message_template",
        resourceId: input.id,
        details: { name: input.name, type: input.type, channel: input.channel, is_active: input.is_active, variables: usedVariables(input.body, input.subject) },
      });
      return ok({ id: data[0].id, updated_at: data[0].updated_at });
    }

    const { data, error } = await ctx.supabase.from("message_templates").insert(row).select("id, updated_at").single();
    throwIfDbError(error, { uniqueField: "name", uniqueMessage: DUPLICATE_NAME });
    const created = data as { id: string; updated_at: string };
    await ctx.audit({
      event: "data_create",
      resourceType: "message_template",
      resourceId: created.id,
      details: { name: input.name, type: input.type, channel: input.channel, is_active: input.is_active, variables: usedVariables(input.body, input.subject) },
    });
    return ok(created);
  },
);

export const setMessageTemplateActive = defineAction(
  { name: "message_templates.set_active", schema: SetTemplateActiveSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase
      .from("message_templates")
      .update({ is_active: input.is_active })
      .eq("id", input.id)
      .eq("updated_at", input.expected_updated_at)
      .select("id, name");
    throwIfDbError(error);
    if (!data || data.length === 0) {
      const c = await conflictMessage(ctx.supabase, input.id);
      return fail(c.message, { code: c.code });
    }
    await ctx.audit({ event: "data_update", resourceType: "message_template", resourceId: input.id, details: { name: String(data[0].name), is_active: input.is_active } });
    return ok({ id: input.id });
  },
);

export const duplicateMessageTemplate = defineAction(
  { name: "message_templates.duplicate", schema: TemplateIdSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; name: string; updated_at: string }>> => {
    const { data: source, error } = await ctx.supabase.from("message_templates").select("name, type, channel, subject, body").eq("id", input.id).maybeSingle();
    throwIfDbError(error);
    if (!source) return fail("That template no longer exists.", { code: "not_found" });
    const base = String(source.name).replace(/\s+\(copy(?: \d+)?\)$/i, "");
    const { data: similar, error: listError } = await ctx.supabase
      .from("message_templates")
      .select("name")
      .ilike("name", `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .limit(1000);
    throwIfDbError(listError);
    const name = copyName(String(source.name), (similar ?? []).map((s) => String(s.name)));
    const { data, error: insertError } = await ctx.supabase
      .from("message_templates")
      .insert({ name, type: source.type, channel: source.channel, subject: source.subject, body: source.body, is_active: false })
      .select("id, updated_at")
      .single();
    throwIfDbError(insertError, { uniqueMessage: DUPLICATE_NAME });
    const { id, updated_at } = data as { id: string; updated_at: string };
    await ctx.audit({ event: "data_create", resourceType: "message_template", resourceId: id, details: { name, copied_from: input.id, is_active: false } });
    return ok({ id, name, updated_at });
  },
);

export const deleteMessageTemplate = defineAction(
  { name: "message_templates.delete", schema: TemplateIdSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("message_templates").delete().eq("id", input.id).select("id, name, type");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That template no longer exists.", { code: "not_found" });
    // Messages written from it keep their text; their template link is cleared (on delete set null).
    await ctx.audit({ event: "data_delete", resourceType: "message_template", resourceId: input.id, details: { name: String(data[0].name), type: data[0].type } });
    return ok({ id: input.id });
  },
);
