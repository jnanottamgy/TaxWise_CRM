"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { TEAM_ROLE_LABELS, type TeamRole } from "@/lib/domain/enums";
import { getEmployeeNames } from "@/lib/data/people";
import {
  CALENDAR_FIELDS,
  MasterDataSchema,
  changedMasterFields,
  describeChanges,
  masterDataToRow,
  masterDataWarnings,
  type MasterDataRow,
} from "@/components/client360/logic/master-data";
import {
  ClientGroupSchema,
  ClientNotesSchema,
  ClientTeamSchema,
  TAX_AUDIT_DECISION_LABELS,
  TaxAuditDecisionSchema,
} from "@/components/client360/logic/profile-schemas";
import { describeTeamChange } from "@/components/client360/logic/team";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";
import { generateForClient } from "@/server/compliance/generate";
import { todayIST } from "@/lib/domain/fy";

/**
 * Client 360 → Profile & contacts (§7.3.3 tab 2) and the Overview's tax-audit decision (§6.6):
 *
 *   updateMasterData     Partner/Manager: the wizard's step 1 fields plus priority and how the
 *                        income is earned (presumptive s.44AD / s.44ADA, §6.6), with the same
 *                        validators, optimistic concurrency (§13) and the PAN holder-type warning;
 *                        a change to a calendar fact refreshes the client's deadlines.
 *   updateClientNotes    anyone who can see the client: an Employee's limited edit (§4.1, 0033 guard).
 *   setTaxAuditDecision  Partner only (§6.6; the 0115 guard refuses anyone else): yes / no / review.
 *   setClientGroup       Partner/Manager: join an existing group, a new one, or none (§7.4).
 *   setClientTeam        Partner/Manager: owner, engagement partner, review manager and preparers in
 *                        one transaction (set_client_team, 0115).
 *
 * Every save writes an audit row and a timeline entry; nothing here touches fees.
 */

const MANAGERS = ["partner", "manager"] as const;

async function conflictMessage(ctx: ActionContext, clientId: string): Promise<string> {
  const { data } = await ctx.supabase.rpc("client_change_conflict", { p_client_id: clientId });
  return typeof data === "string" && data ? data.replace(/^USER:\s*/, "") : "This client was changed by someone else. Reload to see their changes.";
}

async function loadClient(ctx: ActionContext, clientId: string) {
  const { data, error } = await ctx.supabase
    .from("clients")
    .select(
      "id, client_code, display_name, legal_name, entity_type, entity_type_other, is_incorporated, date_of_birth_or_incorporation, pan, gst_registration, gstin, state_code, tan, email, phone, whatsapp, address, city, pincode, fy_end_month, annual_turnover, turnover_fy, gst_scheme, income_nature, priority, notes, group_id, updated_at, deleted_at",
    )
    .eq("id", clientId)
    .maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
  return data;
}

/** "TW-C-0042 · Sharma Traders already has this PAN." for a unique clash (recycled clients count too). */
async function uniqueClash(ctx: ActionContext, clientId: string, message: string, row: MasterDataRow): Promise<never> {
  const field = message.includes("clients_pan_key") ? "pan" : message.includes("clients_gstin_key") ? "gstin" : message.includes("client_code") ? "clientCode" : null;
  const column = field === "clientCode" ? "client_code" : field;
  let owner = "Another client";
  if (column) {
    const value = (row as Record<string, unknown>)[column];
    const { data } = await ctx.supabase.from("clients").select("client_code, display_name, deleted_at").eq(column, String(value)).neq("id", clientId).maybeSingle();
    if (data) owner = `${String(data.client_code)} · ${data.display_name}${data.deleted_at ? " (in the recycle bin)" : ""}`;
  }
  const what = field === "pan" ? "PAN" : field === "gstin" ? "GSTIN" : field === "clientCode" ? "client code" : "detail";
  const sentence = `${owner} already has this ${what}.`;
  throw new ActionError(sentence, { code: "conflict", fieldErrors: field ? { [field]: [sentence] } : undefined });
}

export const updateMasterData = defineAction(
  { name: "clients.update_master_data", schema: MasterDataSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; changed: string[] }>> => {
    const before = await loadClient(ctx, input.clientId);
    if (before.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    const row = masterDataToRow(input);
    const changed = changedMasterFields(before as unknown as Partial<Record<keyof MasterDataRow, unknown>>, row);
    if (changed.length === 0) return ok({ updatedAt: before.updated_at, changed: [] });

    const { data, error } = await ctx.supabase.from("clients").update(row).eq("id", input.clientId).eq("updated_at", input.updatedAt).select("updated_at");
    if (error?.code === "23505") await uniqueClash(ctx, input.clientId, error.message ?? "", row);
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { updated_at: string } | undefined;
    if (!saved) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    const summary = describeChanges(changed);
    await ctx.audit({
      event: "data_update",
      resourceType: "client",
      resourceId: input.clientId,
      details: { changed, ...(changed.includes("gstin") ? { gstin: row.gstin } : {}), ...(changed.includes("pan") ? { pan: row.pan } : {}) },
    });
    ctx.after("Add the change to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "client_updated",
        title: `Details updated: ${summary}`,
        metadata: { fields: changed },
      }),
    );
    ctx.after("Record the change in the client's history", () =>
      logActivity({ entityType: "client", entityId: input.clientId, action: "client_updated", description: `Updated ${summary}`, metadata: { fields: changed } }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "client_updated", description: `Updated ${row.display_name}: ${summary}`, entityType: "client", entityId: input.clientId, entityName: row.display_name }),
    );
    // The deadline generator reads these facts (presumptive income moves advance tax to one
    // instalment, the GST scheme picks monthly or quarterly returns): refresh the client's deadlines
    // the way Generate deadlines does. Filed and locked deadlines are never touched (0125).
    if (changed.some((f) => CALENDAR_FIELDS.includes(f))) {
      ctx.after(
        "Refresh the client's deadlines",
        async () => {
          await generateForClient(ctx.supabase, input.clientId, { today: todayIST(), retire: true });
        },
        "Details saved, but the deadlines weren't refreshed. Use Generate deadlines on the Compliance tab.",
      );
    }
    return ok({ updatedAt: saved.updated_at, changed }, masterDataWarnings(input));
  },
);

export const updateClientNotes = defineAction(
  { name: "clients.update_notes", schema: ClientNotesSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const before = await loadClient(ctx, input.clientId);
    if (before.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });
    if ((before.notes ?? null) === input.notes) return ok({ updatedAt: before.updated_at });

    const { data, error } = await ctx.supabase.from("clients").update({ notes: input.notes }).eq("id", input.clientId).eq("updated_at", input.updatedAt).select("updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { updated_at: string } | undefined;
    if (!saved) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    await ctx.audit({ event: "data_update", resourceType: "client", resourceId: input.clientId, details: { changed: ["notes"] } });
    ctx.after("Add the change to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "client_notes_updated", title: input.notes ? "Notes updated" : "Notes cleared" }),
    );
    return ok({ updatedAt: saved.updated_at });
  },
);

export const setTaxAuditDecision = defineAction(
  { name: "clients.tax_audit_decision", schema: TaxAuditDecisionSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const before = await loadClient(ctx, input.clientId);
    if (before.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    const { data, error } = await ctx.supabase
      .from("clients")
      .update({ tax_audit_applicable: input.decision, tax_audit_note: input.note })
      .eq("id", input.clientId)
      .eq("updated_at", input.updatedAt)
      .select("updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { updated_at: string } | undefined;
    if (!saved) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    const label = TAX_AUDIT_DECISION_LABELS[input.decision];
    await ctx.audit({ event: "data_update", resourceType: "client", resourceId: input.clientId, details: { tax_audit_applicable: input.decision } });
    ctx.after("Add the decision to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "client_tax_audit_decision",
        title: `Tax-audit decision: ${label}`,
        description: input.note,
        metadata: { decision: input.decision },
      }),
    );
    return ok({ updatedAt: saved.updated_at });
  },
);

export const setClientGroup = defineAction(
  { name: "clients.set_group", schema: ClientGroupSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; groupId: string | null }>> => {
    const before = await loadClient(ctx, input.clientId);
    if (before.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    let groupId = input.groupId;
    let groupName: string | null = null;
    let created = false;
    if (input.newGroupName) {
      const { data, error } = await ctx.supabase.from("client_groups").insert({ name: input.newGroupName }).select("id, name").single();
      if (error?.code === "23505") {
        return fail(`A group called “${input.newGroupName}” already exists. Choose it from the list.`, {
          code: "conflict",
          fieldErrors: { newGroupName: ["That group already exists. Choose it from the list."] },
        });
      }
      throwIfDbError(error);
      groupId = (data as { id: string }).id;
      groupName = String((data as { name: string }).name);
      created = true;
    } else if (groupId) {
      const { data, error } = await ctx.supabase.from("client_groups").select("name").eq("id", groupId).maybeSingle();
      throwIfDbError(error);
      if (!data) return fail("That group no longer exists. Reload to see the current groups.", { code: "not_found", fieldErrors: { groupId: ["Choose a group from the list."] } });
      groupName = String(data.name);
    }
    if ((before.group_id ?? null) === groupId) return ok({ updatedAt: before.updated_at, groupId });

    const { data, error } = await ctx.supabase.from("clients").update({ group_id: groupId }).eq("id", input.clientId).eq("updated_at", input.updatedAt).select("updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { updated_at: string } | undefined;
    if (!saved) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    let previousName: string | null = null;
    if (before.group_id) {
      const { data: prev } = await ctx.supabase.from("client_groups").select("name").eq("id", before.group_id).maybeSingle();
      previousName = prev ? String(prev.name) : null;
    }
    await ctx.audit({ event: "data_update", resourceType: "client", resourceId: input.clientId, details: { group_id: groupId, previous_group_id: before.group_id, created_group: created } });
    ctx.after("Add the change to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "client_group_changed",
        title: groupName ? `Added to the group ${groupName}${previousName ? ` (was ${previousName})` : ""}` : `Removed from the group ${previousName ?? ""}`.trim(),
        metadata: { group_id: groupId },
      }),
    );
    return ok({ updatedAt: saved.updated_at, groupId });
  },
);

export const setClientTeam = defineAction(
  { name: "clients.set_team", schema: ClientTeamSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ signature: string; changes: number }>> => {
    const { data, error } = await ctx.supabase.rpc("set_client_team", {
      p_client_id: input.clientId,
      p_owner: input.owner,
      p_engagement_partner: input.engagementPartner,
      p_review_manager: input.reviewManager,
      p_preparers: input.preparers,
      p_expected_signature: input.signature,
    });
    throwIfDbError(error);
    const r = (data ?? {}) as {
      added?: Array<{ employee_id: string; team_role: TeamRole }>;
      removed?: Array<{ employee_id: string; team_role: TeamRole }>;
      owner_changed?: boolean;
      previous_owner?: string | null;
      owner?: string | null;
      signature?: string;
    };
    const added = r.added ?? [];
    const removed = r.removed ?? [];
    const changes = added.length + removed.length + (r.owner_changed ? 1 : 0);
    if (changes === 0) return ok({ signature: r.signature ?? input.signature, changes: 0 });

    await ctx.audit({
      event: "permission_change",
      resourceType: "client_team",
      resourceId: input.clientId,
      details: { added, removed, owner: r.owner_changed ? { from: r.previous_owner ?? null, to: r.owner ?? null } : undefined },
    });
    ctx.after("Add the team change to the client's timeline", async () => {
      const names = await getEmployeeNames(ctx.supabase, [...added.map((a) => a.employee_id), ...removed.map((x) => x.employee_id), r.owner ?? null]);
      const lines = describeTeamChange(
        { added, removed, ownerChanged: !!r.owner_changed, owner: r.owner ?? null },
        (id) => names.get(id) ?? "A former team member",
        (role) => TEAM_ROLE_LABELS[role as TeamRole] ?? role,
      );
      await addTimelineEvent({
        clientId: input.clientId,
        eventType: "employee_assigned",
        title: lines.length === 1 ? lines[0] : `Team updated: ${lines.length} changes`,
        description: lines.length > 1 ? lines.join(". ") + "." : null,
        metadata: { added, removed, owner_changed: !!r.owner_changed },
      });
    });
    return ok({ signature: r.signature ?? input.signature, changes });
  },
);
