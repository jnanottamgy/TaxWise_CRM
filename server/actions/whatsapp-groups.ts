"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok } from "@/lib/result";
import { formatDate, formatTime } from "@/lib/format";
import { normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import {
  checklistToJson,
  contactWhatsAppDigits,
  membersFromChecklist,
  parseChecklist,
  renderGroupName,
  secondaryGroupName,
  shortClientName,
  tickChecklist,
  validateGroupName,
} from "@/lib/domain/whatsapp";
import {
  AddMemberSchema,
  CloseGroupSchema,
  GroupIdSchema,
  MarkCreatedSchema,
  OpenChatSchema,
  RemoveNumberFromGroupsSchema,
  SelectContactsSchema,
  StartGroupSchema,
  TickStepSchema,
  UpdateGroupSchema,
  UpdateMemberSchema,
} from "@/lib/schemas/whatsapp";
import { z } from "zod";
import { getWhatsAppFirmSettings, listFirmNumbers } from "@/lib/data/whatsapp";
import { addTimelineEvent } from "@/server/timeline";
import { log } from "@/lib/log";

/**
 * Client WhatsApp groups (§7.25.1–§7.25.2): set up, the seven-step checklist, Mark created, close,
 * primary, members, Open chat, and revealing the invite link.
 *
 * Groups and members are written by Partners and Managers only (`roles`, and RLS, §4.6); Open chat
 * is any staff member who can open the client's WhatsApp (can_open_whatsapp, inside
 * record_whatsapp_open). Every mutation is audited; the client timeline records set-up, creation
 * and closing (never anything about money). Edits carry the group's `updated_at` and are refused if
 * someone changed it meanwhile (§13). The invite link never goes to a page except through Reveal,
 * which is audited.
 */

const PM = ["partner", "manager"] as const;
const STAFF = ["partner", "manager", "employee"] as const;

type GroupRow = {
  id: string;
  client_id: string;
  name: string;
  purpose: string | null;
  is_primary: boolean;
  status: "to_create" | "active" | "closed";
  notes: string | null;
  checklist: unknown;
  updated_at: string;
  deleted_at: string | null;
};

const GROUP_COLUMNS = "id, client_id, name, purpose, notes, is_primary, status, checklist, updated_at, deleted_at";

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || Date.parse(a) === Date.parse(b);
}

function changedAt(at: string): string {
  const when = formatDate(at) === formatDate(new Date()) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`;
  return `This group was changed at ${when}. Reload to see the changes.`;
}

async function loadGroup(ctx: ActionContext, groupId: string): Promise<GroupRow> {
  const { data, error } = await ctx.supabase.from("client_whatsapp_groups").select(GROUP_COLUMNS).eq("id", groupId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That WhatsApp group no longer exists. Reload the page.", { code: "not_found" });
  return data as unknown as GroupRow;
}

function assertFresh(group: GroupRow, loaded: string): void {
  if (!sameInstant(group.updated_at, loaded)) throw new ActionError(changedAt(group.updated_at), { code: "conflict" });
}

async function loadClient(ctx: ActionContext, clientId: string): Promise<{ id: string; client_code: string; display_name: string }> {
  const { data, error } = await ctx.supabase.from("clients").select("id, client_code, display_name").eq("id", clientId).is("deleted_at", null).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That client isn't in your client list.", { code: "not_found" });
  return { id: data.id, client_code: String(data.client_code), display_name: data.display_name };
}

const UNIQUE_NAME = "Another open group already has this name. Add the group's purpose to the name to tell them apart.";

// -------------------------------------------------------------------------------------------------
// Set up a group
// -------------------------------------------------------------------------------------------------

/**
 * "Set up the WhatsApp group" (§7.25.2): a To create group named from Settings → WhatsApp → name
 * format. A client can have more than one group (§7.25.2); the first open one is primary, and
 * another takes the purpose in its name so the two can be told apart.
 */
export const startWhatsAppGroup = defineAction({ name: "whatsapp.start_group", schema: StartGroupSchema, roles: PM }, async (input, ctx) => {
  const client = await loadClient(ctx, input.clientId);
  const settings = await getWhatsAppFirmSettings(ctx.supabase);
  const { data: live, error: liveError } = await ctx.supabase
    .from("client_whatsapp_groups")
    .select("id, is_primary")
    .eq("client_id", client.id)
    .is("deleted_at", null)
    .neq("status", "closed");
  throwIfDbError(liveError);
  const hasPrimary = (live ?? []).some((g) => g.is_primary);
  const base = renderGroupName(settings.nameFormat, { clientCode: client.client_code, displayName: client.display_name });
  const first = (live ?? []).length === 0;
  if (!first && !input.name && !input.purpose) {
    const why = "Give this group a purpose (for example: Statutory audit FY 2025-26), so its name differs from the client's other group.";
    return fail(why, { code: "validation", fieldErrors: { purpose: [why] } });
  }
  const name = input.name && input.name.length > 0 ? input.name : first ? base : secondaryGroupName(base, input.purpose);
  const valid = validateGroupName(name, client.client_code);
  if (!valid.ok) return fail(valid.error, { code: "validation", fieldErrors: { name: [valid.error] } });

  const { data, error } = await ctx.supabase
    .from("client_whatsapp_groups")
    .insert({
      client_id: client.id,
      name,
      purpose: input.purpose ?? (first ? "All work" : null),
      is_primary: !hasPrimary,
      status: "to_create",
      checklist: checklistToJson(parseChecklist({})) as never,
    })
    .select("id, name, is_primary, updated_at")
    .single();
  throwIfDbError(error, { uniqueField: "name", uniqueMessage: UNIQUE_NAME });

  await ctx.audit({
    event: "data_create",
    resourceType: "client_whatsapp_group",
    resourceId: data!.id,
    details: { client_id: client.id, name, is_primary: data!.is_primary, purpose: input.purpose ?? null },
  });
  ctx.after("Add to the client's timeline", () =>
    addTimelineEvent({ clientId: client.id, eventType: "whatsapp_group_setup", title: `WhatsApp group set-up started: ${name}`, metadata: { group_id: data!.id } }),
  );
  return ok({ id: data!.id, name, updatedAt: data!.updated_at });
});

/** Name, purpose and notes of a group (Partner/Manager). The name keeps the client code (§5.13). */
export const updateWhatsAppGroup = defineAction({ name: "whatsapp.update_group", schema: UpdateGroupSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  assertFresh(group, input.updatedAt);
  const client = await loadClient(ctx, group.client_id);
  const valid = validateGroupName(input.name, client.client_code);
  if (!valid.ok) return fail(valid.error, { code: "validation", fieldErrors: { name: [valid.error] } });

  const { data, error } = await ctx.supabase
    .from("client_whatsapp_groups")
    .update({ name: input.name, purpose: input.purpose, notes: input.notes })
    .eq("id", group.id)
    .eq("updated_at", group.updated_at)
    .select("updated_at")
    .maybeSingle();
  throwIfDbError(error, { uniqueField: "name", uniqueMessage: UNIQUE_NAME });
  if (!data) return fail("This group was changed by someone else. Reload to see their changes.", { code: "conflict" });

  await ctx.audit({
    event: "data_update",
    resourceType: "client_whatsapp_group",
    resourceId: group.id,
    details: {
      client_id: group.client_id,
      ...(group.name !== input.name ? { name: { before: group.name, after: input.name } } : {}),
      ...(group.purpose !== input.purpose ? { purpose: { before: group.purpose, after: input.purpose } } : {}),
      notes_changed: (group.notes ?? null) !== (input.notes ?? null),
    },
  });
  if (group.name !== input.name && group.status !== "to_create") {
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({ clientId: group.client_id, eventType: "whatsapp_group_renamed", title: `WhatsApp group renamed to ${input.name}`, description: `Was ${group.name}. Rename the group in WhatsApp too, so the name Open chat copies finds it.` }),
    );
  }
  return ok({ updatedAt: data.updated_at });
});

// -------------------------------------------------------------------------------------------------
// The checklist (§7.25.2)
// -------------------------------------------------------------------------------------------------

/** Ticks or unticks steps 1–6, stamped with who and when. */
export const tickWhatsAppStep = defineAction({ name: "whatsapp.tick_step", schema: TickStepSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  assertFresh(group, input.updatedAt);
  if (group.status !== "to_create") return fail("This group is already set up, so its checklist is closed.", { code: "blocked" });
  const next = tickChecklist(parseChecklist(group.checklist), input.step, input.done, ctx.user.id, new Date().toISOString());
  const { data, error } = await ctx.supabase
    .from("client_whatsapp_groups")
    .update({ checklist: checklistToJson(next) as never })
    .eq("id", group.id)
    .eq("updated_at", group.updated_at)
    .select("updated_at")
    .maybeSingle();
  throwIfDbError(error);
  if (!data) return fail("This group was changed by someone else. Reload to see their changes.", { code: "conflict" });
  await ctx.audit({ event: "data_update", resourceType: "client_whatsapp_group", resourceId: group.id, details: { client_id: group.client_id, step: input.step, done: input.done } });
  return ok({ updatedAt: data.updated_at, at: next.steps[input.step].at });
});

/** Step 3: the client contacts to add (the primary contact is ticked by default). */
export const saveWhatsAppContacts = defineAction({ name: "whatsapp.select_contacts", schema: SelectContactsSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  assertFresh(group, input.updatedAt);
  if (group.status !== "to_create") return fail("This group is already set up. Add members from the group card instead.", { code: "blocked" });
  const ids = [...new Set(input.contactIds)];
  if (ids.length) {
    const { data: contacts, error } = await ctx.supabase.from("client_contacts").select("id").eq("client_id", group.client_id).in("id", ids);
    throwIfDbError(error);
    if ((contacts ?? []).length !== ids.length) return fail("Some of those contacts belong to another client or were deleted. Reload the page.", { code: "blocked" });
  }
  const state = { ...parseChecklist(group.checklist), contactIds: ids };
  const { data, error } = await ctx.supabase
    .from("client_whatsapp_groups")
    .update({ checklist: checklistToJson(state) as never })
    .eq("id", group.id)
    .eq("updated_at", group.updated_at)
    .select("updated_at")
    .maybeSingle();
  throwIfDbError(error);
  if (!data) return fail("This group was changed by someone else. Reload to see their changes.", { code: "conflict" });
  await ctx.audit({ event: "data_update", resourceType: "client_whatsapp_group", resourceId: group.id, details: { client_id: group.client_id, contacts_ticked: ids.length } });
  return ok({ updatedAt: data.updated_at });
});

/**
 * Step 7, Mark the group created (§7.25.2): the date, the firm number that created it and the
 * invite link; the group becomes Active and its members fill in from the checklist (every active
 * firm number in every client group, and the contacts ticked in step 3), in one transaction.
 */
export const markWhatsAppGroupCreated = defineAction({ name: "whatsapp.mark_created", schema: MarkCreatedSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  assertFresh(group, input.updatedAt);
  if (group.status === "active") return fail("This group is already marked created.", { code: "blocked" });
  if (group.status === "closed") return fail("This group is closed. Set up a new group for the client instead.", { code: "blocked" });

  const client = await loadClient(ctx, group.client_id);
  const [settings, numbers, contactsRes] = await Promise.all([
    getWhatsAppFirmSettings(ctx.supabase),
    listFirmNumbers(ctx.supabase),
    ctx.supabase.from("client_contacts").select("id, name, role, whatsapp, phone, is_primary").eq("client_id", client.id).limit(100),
  ]);
  throwIfDbError(contactsRes.error);
  const creator = numbers.find((n) => n.id === input.createdByNumberId);
  if (!creator || !creator.is_active || !creator.number) {
    return fail("Choose an active firm number. Numbers are switched on in Settings → WhatsApp.", { code: "validation", fieldErrors: { createdByNumberId: ["Choose an active firm number."] } });
  }
  const checklist = parseChecklist(group.checklist);
  const ownerNames = new Map(numbers.filter((n) => n.employee_id && n.owner_name).map((n) => [n.employee_id!, n.owner_name!]));
  const members = membersFromChecklist({
    firmNumbers: numbers,
    contacts: contactsRes.data ?? [],
    selectedContactIds: checklist.contactIds,
    shortName: shortClientName(client.display_name),
    countryCode: settings.countryCode,
    ownerNames,
    createdByNumberId: creator.id,
  });

  const { data, error } = await ctx.supabase.rpc("mark_whatsapp_group_created", {
    p_group_id: group.id,
    p_expected_updated_at: group.updated_at,
    p_created_on: input.createdOn,
    p_created_by_number_id: creator.id,
    p_invite_link: input.inviteLink,
    p_members: members as never,
  });
  throwIfDbError(error);
  const r = data as { members: number; admins: number; updated_at: string; created_by_label: string };

  await ctx.audit({
    event: "data_update",
    resourceType: "client_whatsapp_group",
    resourceId: group.id,
    action: "whatsapp.group_created",
    details: { client_id: client.id, created_on: input.createdOn, created_by: creator.label, members: r.members, admins: r.admins, invite_link_saved: !!input.inviteLink },
  });
  ctx.after("Add to the client's timeline", () =>
    addTimelineEvent({
      clientId: client.id,
      eventType: "whatsapp_group_created",
      title: `WhatsApp group created: ${group.name}`,
      description: `${r.members} members, created from the ${creator.label} number on ${formatDate(input.createdOn)}.`,
      metadata: { group_id: group.id, members: r.members },
    }),
  );
  ctx.after("Close the set-up to-do", () => closeSetupTodo(ctx, client.id, group.name));
  return ok({ members: r.members, admins: r.admins, updatedAt: r.updated_at });
});

/**
 * The "Set up the WhatsApp group" to-do the onboarding put on the engagement partner's list
 * (§7.3.2): marked done now the group exists. Best effort: a to-do the task rules won't let this
 * person close (a Manager's own task, say) is left for its assignee and only logged.
 */
async function closeSetupTodo(ctx: ActionContext, clientId: string, groupName: string): Promise<void> {
  try {
    const { data, error } = await ctx.supabase
      .from("tasks")
      .select("id")
      .eq("client_id", clientId)
      .eq("title", "Set up the WhatsApp group")
      .is("deleted_at", null)
      .neq("status", "filed_done")
      .limit(5);
    if (error) throw error;
    for (const t of data ?? []) {
      const r = await ctx.supabase.rpc("change_task_status", { p_task_id: t.id, p_to: "filed_done", p_reason: `WhatsApp group ${groupName} marked created.` });
      if (r.error) log("info", "set-up to-do left open", { source: "action:whatsapp.mark_created", userId: ctx.user.id, taskId: t.id, err: r.error });
    }
  } catch (err) {
    log("warn", "set-up to-do not closed", { source: "action:whatsapp.mark_created", userId: ctx.user.id, err });
  }
}

/** Close group (§7.25.2): a reason and a closing date; the next open group becomes primary. */
export const closeWhatsAppGroup = defineAction({ name: "whatsapp.close_group", schema: CloseGroupSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  assertFresh(group, input.updatedAt);
  const { data, error } = await ctx.supabase.rpc("close_whatsapp_group", {
    p_group_id: group.id,
    p_expected_updated_at: group.updated_at,
    p_closed_on: input.closedOn,
    p_reason: input.reason,
  });
  throwIfDbError(error);
  const r = data as { promoted_id: string | null; was_status: string };
  await ctx.audit({
    event: "data_update",
    resourceType: "client_whatsapp_group",
    resourceId: group.id,
    action: "whatsapp.group_closed",
    details: { client_id: group.client_id, closed_on: input.closedOn, reason: input.reason, promoted_id: r.promoted_id, was: r.was_status },
  });
  ctx.after("Add to the client's timeline", () =>
    addTimelineEvent({ clientId: group.client_id, eventType: "whatsapp_group_closed", title: `WhatsApp group closed: ${group.name}`, description: input.reason, metadata: { group_id: group.id, closed_on: input.closedOn } }),
  );
  return ok({ promotedId: r.promoted_id });
});

/** Make a group the client's primary group (one per client among open groups). */
export const setPrimaryWhatsAppGroup = defineAction({ name: "whatsapp.set_primary", schema: GroupIdSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  const { data, error } = await ctx.supabase.rpc("set_primary_whatsapp_group", { p_group_id: group.id });
  throwIfDbError(error);
  const r = data as { changed: boolean; previous_id: string | null };
  if (r.changed) {
    await ctx.audit({ event: "data_update", resourceType: "client_whatsapp_group", resourceId: group.id, action: "whatsapp.set_primary", details: { client_id: group.client_id, previous_id: r.previous_id } });
  }
  return ok({ changed: r.changed });
});

// -------------------------------------------------------------------------------------------------
// Open chat (§7.25.8) and the invite link
// -------------------------------------------------------------------------------------------------

/**
 * The server check behind Open chat (§7.25.1, §7.25.8), in a browser window or the phone app:
 * record_whatsapp_open (can_open_whatsapp; Employees only when a Partner allows WhatsApp in a
 * browser window; only an Active group), which writes the audit row and last opened. Answers the
 * group's name to copy. Its refusal for an Employee still names TaxWise Desktop (0181), so that one
 * message is reworded here.
 */
export const openWhatsAppChat = defineAction({ name: "whatsapp.open_chat", schema: OpenChatSchema, roles: STAFF }, async (input, ctx) => {
  const { data, error } = await ctx.supabase.rpc("record_whatsapp_open", {
    p_client_id: input.clientId,
    p_group_id: input.groupId,
    p_via: input.via,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });
  throwIfDbError(error);
  const r = data as { status: string; error?: string; group?: { name: string } };
  if (r.status === "forbidden") {
    const browserOff = r.error?.includes("TaxWise Desktop") ? "Open chat is off for Employees: a Partner hasn't allowed WhatsApp in a browser window." : null;
    return fail(browserOff ?? r.error ?? "Not one of your clients.", { code: "forbidden" });
  }
  if (r.status !== "ok" || !r.group) return fail(r.error ?? "This client has no WhatsApp group yet.", { code: "blocked" });
  return ok({ groupName: r.group.name });
});

/** Reveal the invite link (§7.25.1: Partner/Manager only, hidden until Reveal). Audited. */
export const revealWhatsAppInviteLink = defineAction({ name: "whatsapp.reveal_invite_link", schema: GroupIdSchema, roles: PM }, async (input, ctx) => {
  const { data, error } = await ctx.supabase.from("client_whatsapp_groups").select("id, client_id, invite_link, deleted_at").eq("id", input.groupId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) return fail("That WhatsApp group no longer exists. Reload the page.", { code: "not_found" });
  if (!data.invite_link) return fail("No invite link is saved for this group. Add it when you mark the group created, or from Edit.", { code: "not_found" });
  await ctx.audit({ event: "record_viewed", resourceType: "client_whatsapp_group", resourceId: data.id, action: "whatsapp.invite_link_revealed", details: { client_id: data.client_id } });
  return ok({ link: data.invite_link });
});

const InviteLinkSchema = z.object({
  groupId: z.uuid({ error: "Reload the page and try again." }),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
  inviteLink: MarkCreatedSchema.shape.inviteLink,
});

/** Save or clear a group's invite link (WhatsApp → Group info → Invite via link; Partner/Manager). */
export const saveWhatsAppInviteLink = defineAction({ name: "whatsapp.save_invite_link", schema: InviteLinkSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  assertFresh(group, input.updatedAt);
  const { data, error } = await ctx.supabase
    .from("client_whatsapp_groups")
    .update({ invite_link: input.inviteLink })
    .eq("id", group.id)
    .eq("updated_at", group.updated_at)
    .select("updated_at")
    .maybeSingle();
  throwIfDbError(error);
  if (!data) return fail("This group was changed by someone else. Reload to see their changes.", { code: "conflict" });
  await ctx.audit({ event: "data_update", resourceType: "client_whatsapp_group", resourceId: group.id, action: "whatsapp.save_invite_link", details: { client_id: group.client_id, invite_link_saved: !!input.inviteLink } });
  return ok({ updatedAt: data.updated_at, saved: !!input.inviteLink });
});

// -------------------------------------------------------------------------------------------------
// Members
// -------------------------------------------------------------------------------------------------

/** Add a member by hand (`source = 'manual'`): a firm number, one of the client's contacts, or another person. */
export const addWhatsAppMember = defineAction({ name: "whatsapp.add_member", schema: AddMemberSchema, roles: PM }, async (input, ctx) => {
  const group = await loadGroup(ctx, input.groupId);
  if (group.status === "closed") return fail("This group is closed, so its members can't change.", { code: "blocked" });
  const settings = await getWhatsAppFirmSettings(ctx.supabase);
  let row: { kind: "firm_number" | "client_contact" | "other_person"; firm_number_id: string | null; contact_id: string | null; display_name: string; number: string };
  if (input.kind === "firm_number") {
    const { data: n, error } = await ctx.supabase.from("firm_whatsapp_numbers").select("id, label, number, is_active").eq("id", input.firmNumberId!).maybeSingle();
    throwIfDbError(error);
    if (!n || !n.is_active || !n.number) return fail("Choose an active firm number.", { code: "validation", fieldErrors: { firmNumberId: ["Choose an active firm number."] } });
    row = { kind: "firm_number", firm_number_id: n.id, contact_id: null, display_name: n.label, number: n.number };
  } else if (input.kind === "client_contact") {
    const { data: c, error } = await ctx.supabase.from("client_contacts").select("id, name, role, whatsapp, phone").eq("id", input.contactId!).eq("client_id", group.client_id).maybeSingle();
    throwIfDbError(error);
    if (!c) return fail("That contact belongs to another client or was deleted.", { code: "validation", fieldErrors: { contactId: ["Choose one of this client's contacts."] } });
    const digits = contactWhatsAppDigits(c, settings.countryCode);
    if (!digits) return fail(`${c.name} has no number WhatsApp can use. Add one in Contacts first.`, { code: "validation", fieldErrors: { contactId: ["No WhatsApp number for this contact."] } });
    row = { kind: "client_contact", firm_number_id: null, contact_id: c.id, display_name: `${c.name}${c.role ? ` (${c.role})` : ""}`, number: digits };
  } else {
    const digits = normalizeWhatsAppNumber(input.number ?? "", { countryCode: settings.countryCode });
    if (!digits) return fail("Enter a mobile number WhatsApp can use, like +91 98765 43210.", { code: "validation", fieldErrors: { number: ["Enter a mobile number WhatsApp can use."] } });
    row = { kind: "other_person", firm_number_id: null, contact_id: null, display_name: input.displayName!, number: digits };
  }
  const { data, error } = await ctx.supabase
    .from("client_whatsapp_group_members")
    .insert({ group_id: group.id, ...row, is_admin: input.isAdmin, added_on: input.addedOn, source: "manual" })
    .select("id")
    .single();
  throwIfDbError(error, { uniqueMessage: "That number is already in this group." });
  await ctx.audit({ event: "data_create", resourceType: "client_whatsapp_group_member", resourceId: data!.id, details: { group_id: group.id, client_id: group.client_id, kind: row.kind, name: row.display_name } });
  return ok({ id: data!.id });
});

/** Make a member an admin (or not), or record that they left the group. */
export const updateWhatsAppMember = defineAction({ name: "whatsapp.update_member", schema: UpdateMemberSchema, roles: PM }, async (input, ctx) => {
  const { data: member, error } = await ctx.supabase
    .from("client_whatsapp_group_members")
    .select("id, group_id, display_name, is_admin, removed_on, added_on, updated_at")
    .eq("id", input.memberId)
    .maybeSingle();
  throwIfDbError(error);
  if (!member) return fail("That member is no longer listed. Reload the page.", { code: "not_found" });
  if (!sameInstant(member.updated_at, input.updatedAt)) return fail("This member was changed by someone else. Reload to see their changes.", { code: "conflict" });
  const patch: { is_admin?: boolean; removed_on?: string } = {};
  if (input.isAdmin !== undefined && input.isAdmin !== member.is_admin) patch.is_admin = input.isAdmin;
  if (input.removedOn !== null && !member.removed_on) {
    if (member.added_on && input.removedOn < member.added_on) return fail(`They were added on ${formatDate(member.added_on)}; choose that date or later.`, { code: "validation" });
    patch.removed_on = input.removedOn;
  }
  if (Object.keys(patch).length === 0) return ok({ changed: false });
  const { data: saved, error: saveError } = await ctx.supabase
    .from("client_whatsapp_group_members")
    .update(patch)
    .eq("id", member.id)
    .eq("updated_at", member.updated_at)
    .select("id")
    .maybeSingle();
  throwIfDbError(saveError);
  if (!saved) return fail("This member was changed by someone else. Reload to see their changes.", { code: "conflict" });
  await ctx.audit({ event: "data_update", resourceType: "client_whatsapp_group_member", resourceId: member.id, details: { group_id: member.group_id, name: member.display_name, ...patch } });
  return ok({ changed: true });
});

/** House rule 7: a departed Partner's number, recorded as removed from the chosen groups. */
export const removeNumberFromGroups = defineAction({ name: "whatsapp.remove_number_from_groups", schema: RemoveNumberFromGroupsSchema, roles: PM }, async (input, ctx) => {
  const { data, error } = await ctx.supabase.rpc("remove_firm_number_from_groups", { p_number_id: input.numberId, p_group_ids: input.groupIds, p_removed_on: undefined });
  throwIfDbError(error);
  const count = (data as number | null) ?? 0;
  await ctx.audit({ event: "data_update", resourceType: "firm_whatsapp_number", resourceId: input.numberId, action: "whatsapp.remove_number_from_groups", details: { groups: input.groupIds.length, removed: count } });
  return ok({ removed: count });
});
