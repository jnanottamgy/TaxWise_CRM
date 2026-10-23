"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { CONTACT_LIMITS, CreateContactSchema, DeleteContactSchema, SetPrimaryContactSchema, UpdateContactSchema } from "@/lib/schemas/contacts";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * Client contacts (§5.3, §7.3.3 Profile & contacts → Contacts), Partner/Manager only (RLS 0033):
 * add, edit, delete, make primary. "Exactly one primary" is kept by the database guard (0115): the
 * first contact becomes primary, a new primary demotes the old one in the same statement, and
 * deleting the primary promotes the oldest remaining contact. Edits carry the row's updated_at
 * (§13). Each writes an audit row and a timeline entry (§0.2). No money is involved.
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This contact was changed by someone else. Reload to see their changes.";

async function clientLabel(ctx: ActionContext, clientId: string): Promise<{ id: string; display_name: string; client_code: string }> {
  const { data, error } = await ctx.supabase.from("clients").select("id, display_name, client_code, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
  return { id: data.id, display_name: data.display_name, client_code: String(data.client_code) };
}

function who(name: string, role: string | null): string {
  return role ? `${name} (${role})` : name;
}

export const createContact = defineAction(
  { name: "contacts.create", schema: CreateContactSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; isPrimary: boolean }>> => {
    const client = await clientLabel(ctx, input.clientId);
    const { count, error: countError } = await ctx.supabase.from("client_contacts").select("id", { count: "exact", head: true }).eq("client_id", client.id);
    throwIfDbError(countError);
    if ((count ?? 0) >= CONTACT_LIMITS.perClient) return fail(`A client can have at most ${CONTACT_LIMITS.perClient} contacts. Remove one first.`, { code: "blocked" });

    const { data, error } = await ctx.supabase
      .from("client_contacts")
      .insert({
        client_id: client.id,
        name: input.name,
        role: input.role,
        email: input.email,
        phone: input.phone,
        whatsapp: input.whatsapp,
        handles: input.handles,
        notes: input.notes,
        is_primary: input.isPrimary,
      })
      .select("id, is_primary")
      .single();
    throwIfDbError(error);
    const row = data as { id: string; is_primary: boolean };

    await ctx.audit({
      event: "data_create",
      resourceType: "client_contact",
      resourceId: row.id,
      details: { client_id: client.id, role: input.role, handles: input.handles, is_primary: row.is_primary },
    });
    ctx.after("Add the contact to the client's timeline", () =>
      addTimelineEvent({
        clientId: client.id,
        eventType: "contact_added",
        title: `Contact added: ${who(input.name, input.role)}${row.is_primary ? ", now the primary contact" : ""}`,
        metadata: { contact_id: row.id },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "client_updated", description: `Added contact ${input.name} to ${client.display_name}`, entityType: "client", entityId: client.id, entityName: client.display_name }),
    );
    return ok({ id: row.id, isPrimary: row.is_primary });
  },
);

export const updateContact = defineAction(
  { name: "contacts.update", schema: UpdateContactSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const { data: before, error: readError } = await ctx.supabase
      .from("client_contacts")
      .select("id, client_id, name, role, email, phone, whatsapp, handles, notes, updated_at")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(readError);
    if (!before || before.client_id !== input.clientId) return fail("That contact no longer exists. Reload to see the current contacts.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });

    const emailChanged = (before.email ? String(before.email) : null) !== input.email;
    const { data, error } = await ctx.supabase
      .from("client_contacts")
      .update({
        name: input.name,
        role: input.role,
        email: input.email,
        phone: input.phone,
        whatsapp: input.whatsapp,
        handles: input.handles,
        notes: input.notes,
        // A new address isn't known to bounce (§7.13.5 "Bounces flag the contact's email as bad").
        ...(emailChanged ? { email_bounced: false } : {}),
      })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    throwIfDbError(error);
    const row = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!row) return fail(STALE, { code: "conflict" });

    const changed: string[] = [];
    if (before.name !== input.name) changed.push("name");
    if ((before.role ?? null) !== input.role) changed.push("role");
    if (emailChanged) changed.push("email");
    if ((before.phone ?? null) !== input.phone) changed.push("phone");
    if ((before.whatsapp ?? null) !== input.whatsapp) changed.push("WhatsApp");
    if ((before.handles ?? []).join(",") !== input.handles.join(",")) changed.push("services handled");
    if ((before.notes ?? null) !== input.notes) changed.push("notes");

    await ctx.audit({ event: "data_update", resourceType: "client_contact", resourceId: row.id, details: { client_id: input.clientId, changed } });
    if (changed.length > 0) {
      ctx.after("Add the change to the client's timeline", () =>
        addTimelineEvent({
          clientId: input.clientId,
          eventType: "contact_updated",
          title: `Contact updated: ${input.name} (${changed.join(", ")})`,
          metadata: { contact_id: row.id, changed },
        }),
      );
    }
    return ok({ id: row.id, updatedAt: row.updated_at });
  },
);

export const deleteContact = defineAction(
  { name: "contacts.delete", schema: DeleteContactSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; newPrimaryName: string | null }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("client_contacts").select("id, client_id, name, role, is_primary, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before || before.client_id !== input.clientId) return fail("That contact has already been removed. Reload to see the current contacts.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });

    const { data, error } = await ctx.supabase.from("client_contacts").delete().eq("id", input.id).eq("updated_at", input.updatedAt).select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail(STALE, { code: "conflict" });

    let newPrimaryName: string | null = null;
    if (before.is_primary) {
      const { data: next } = await ctx.supabase.from("client_contacts").select("name").eq("client_id", input.clientId).eq("is_primary", true).maybeSingle();
      newPrimaryName = next?.name ?? null;
    }

    await ctx.audit({ event: "data_delete", resourceType: "client_contact", resourceId: input.id, details: { client_id: input.clientId, was_primary: before.is_primary } });
    ctx.after("Add the removal to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "contact_removed",
        title: `Contact removed: ${who(before.name, before.role)}${newPrimaryName ? `. ${newPrimaryName} is now the primary contact` : ""}`,
        metadata: { contact_id: input.id },
      }),
    );
    return ok({ id: input.id, newPrimaryName });
  },
);

export const setPrimaryContact = defineAction(
  { name: "contacts.set_primary", schema: SetPrimaryContactSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; changed: boolean }>> => {
    const { data, error } = await ctx.supabase.rpc("set_primary_contact", { p_contact_id: input.id, p_updated_at: input.updatedAt });
    throwIfDbError(error);
    const r = (data ?? {}) as { id?: string; client_id?: string; name?: string; previous_id?: string | null; changed?: boolean };
    if (r.client_id !== input.clientId) return fail("That contact isn't one of this client's contacts.", { code: "validation" });
    if (!r.changed) return ok({ id: input.id, changed: false });

    await ctx.audit({ event: "data_update", resourceType: "client_contact", resourceId: input.id, action: "contacts.set_primary", details: { client_id: input.clientId, previous_primary: r.previous_id ?? null } });
    ctx.after("Add the change to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "contact_primary_changed", title: `${r.name ?? "A contact"} is now the primary contact`, metadata: { contact_id: input.id } }),
    );
    ctx.after("Record the change in the contact's history", () =>
      logActivity({ entityType: "client_contact", entityId: input.id, action: "primary_set", description: `Made the primary contact`, metadata: { previous_primary: r.previous_id ?? null } }),
    );
    return ok({ id: input.id, changed: true });
  },
);

