"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { formatDate } from "@/lib/format";
import { addTimelineEvent } from "@/server/timeline";
import { searchRegisterClients } from "@/lib/data/registers";
import type { ComboOption } from "@/components/app/form/combobox";
import {
  ClientSearchSchema,
  CreateRegistrationSchema,
  RecordRefSchema,
  UpdateRegistrationSchema,
  checkRegistrationNumber,
  registrationTypeLabel,
  type RegistrationType,
} from "@/lib/schemas/registers";

/**
 * Statutory registrations (§7.15.1): GST, PT, IEC, Udyam, FSSAI, Shops & Establishment, PF, ESIC,
 * DIN (with the last DIR-3 KYC Web FY), LLPIN, CIN, TAN, Other. Partners and Managers write (RLS
 * 0037); Employees read their own clients'. Each change writes an audit row and a timeline entry;
 * edits carry updated_at (§13). A DIN's KYC year feeds the compliance engine's DIR-3 KYC deadlines.
 * Also the register forms' client search (any staff member, their own clients for an Employee).
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This registration was changed by someone else. Reload to see their changes.";

async function liveClient(ctx: ActionContext, clientId: string): Promise<{ id: string; display_name: string }> {
  const { data, error } = await ctx.supabase.from("clients").select("id, display_name, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
  return data;
}

function normalised(type: RegistrationType, number: string): { value: string; warning: string | null } {
  const r = checkRegistrationNumber(type, number);
  if (!r.ok) throw new ActionError(r.error, { code: "validation", fieldErrors: { registrationNumber: [r.error] } });
  return { value: r.value, warning: r.warning };
}

export const searchClientsForRegisters = defineAction(
  { name: "registers.search_clients", schema: ClientSearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchRegisterClients(ctx.supabase, input.q)),
);

export const createRegistration = defineAction(
  { name: "registrations.create", schema: CreateRegistrationSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const client = await liveClient(ctx, input.clientId);
    const n = normalised(input.registrationType, input.registrationNumber);
    const { data, error } = await ctx.supabase
      .from("statutory_registrations")
      .insert({
        client_id: client.id,
        registration_type: input.registrationType,
        registration_number: n.value,
        jurisdiction: input.jurisdiction,
        issue_date: input.issueDate,
        expiry_date: input.expiryDate,
        reminder_days: input.reminderDays,
        status: input.status,
        last_dir3_kyc_fy: input.registrationType === "DIN" ? input.lastDir3KycFy : null,
        notes: input.notes,
      })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = (data as { id: string }).id;
    const label = registrationTypeLabel(input.registrationType);
    await ctx.audit({ event: "data_create", resourceType: "statutory_registration", resourceId: id, details: { client_id: client.id, type: input.registrationType, number: n.value, expiry_date: input.expiryDate } });
    ctx.after("Add the registration to the client's timeline", () =>
      addTimelineEvent({
        clientId: client.id,
        eventType: "registration_added",
        title: `${label} registration added: ${n.value}${input.expiryDate ? `, expires ${formatDate(input.expiryDate)}` : ""}`,
        metadata: { registration_id: id, type: input.registrationType },
      }),
    );
    return ok({ id }, n.warning ? [n.warning] : undefined);
  },
);

export const updateRegistration = defineAction(
  { name: "registrations.update", schema: UpdateRegistrationSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const { data: before, error: readError } = await ctx.supabase
      .from("statutory_registrations")
      .select("id, client_id, registration_type, registration_number, expiry_date, status, last_dir3_kyc_fy, updated_at")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That registration no longer exists. Reload to see the register.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const n = normalised(input.registrationType, input.registrationNumber);
    const { data, error } = await ctx.supabase
      .from("statutory_registrations")
      .update({
        registration_type: input.registrationType,
        registration_number: n.value,
        jurisdiction: input.jurisdiction,
        issue_date: input.issueDate,
        expiry_date: input.expiryDate,
        reminder_days: input.reminderDays,
        status: input.status,
        last_dir3_kyc_fy: input.registrationType === "DIN" ? input.lastDir3KycFy : null,
        notes: input.notes,
      })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    throwIfDbError(error);
    const row = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!row) return fail(STALE, { code: "conflict" });

    const changed: string[] = [];
    if (before.registration_number !== n.value || before.registration_type !== input.registrationType) changed.push("number");
    if ((before.expiry_date ?? null) !== input.expiryDate) changed.push("expiry date");
    if (before.status !== input.status) changed.push("status");
    if ((before.last_dir3_kyc_fy ?? null) !== (input.registrationType === "DIN" ? input.lastDir3KycFy : null)) changed.push("DIR-3 KYC year");
    await ctx.audit({ event: "data_update", resourceType: "statutory_registration", resourceId: row.id, details: { client_id: before.client_id, changed, status: input.status } });
    if (changed.length) {
      const label = registrationTypeLabel(input.registrationType);
      ctx.after("Add the change to the client's timeline", () =>
        addTimelineEvent({
          clientId: before.client_id,
          eventType: "registration_updated",
          title: `${label} registration ${n.value} updated (${changed.join(", ")})`,
          metadata: { registration_id: row.id, changed },
        }),
      );
    }
    return ok({ id: row.id, updatedAt: row.updated_at }, n.warning ? [n.warning] : undefined);
  },
);

export const deleteRegistration = defineAction(
  { name: "registrations.delete", schema: RecordRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("statutory_registrations").select("id, client_id, registration_type, registration_number, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That registration has already been removed.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const { data, error } = await ctx.supabase.from("statutory_registrations").delete().eq("id", input.id).eq("updated_at", input.updatedAt).select("id");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_delete", resourceType: "statutory_registration", resourceId: input.id, details: { client_id: before.client_id, type: before.registration_type, number: before.registration_number } });
    ctx.after("Add the removal to the client's timeline", () =>
      addTimelineEvent({
        clientId: before.client_id,
        eventType: "registration_removed",
        title: `${registrationTypeLabel(before.registration_type)} registration ${before.registration_number} removed from the register`,
        metadata: { registration_id: input.id },
      }),
    );
    return ok({ id: input.id });
  },
);
