"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { formatDate } from "@/lib/format";
import { diffDays, todayIST } from "@/lib/domain/fy";
import { addTimelineEvent } from "@/server/timeline";
import { CreateDscSchema, RecordRefSchema, UpdateDscSchema, custodyLabel, custodyValue } from "@/lib/schemas/registers";

/**
 * The DSC register (§7.15.1): holder, PAN, class, serial, issuer, dates, custody (Firm, Client or a
 * named person) and status. Partners and Managers write (RLS 0037); Employees read their own
 * clients'. Alerts at 30, 15 and 7 days come from the register-expiries job. Each change writes an
 * audit row and a timeline entry; edits carry updated_at (§13).
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This DSC was changed by someone else. Reload to see their changes.";

function expiryWarning(expiry: string, status: string): string[] | undefined {
  if (status !== "active") return undefined;
  const left = diffDays(expiry, todayIST());
  if (left < 0) return [`This DSC expired on ${formatDate(expiry)}. It shows as Expired until it's renewed or marked revoked.`];
  if (left <= 30) return [`This DSC expires in ${left} ${left === 1 ? "day" : "days"} (${formatDate(expiry)}). Arrange the renewal.`];
  return undefined;
}

export const createDsc = defineAction(
  { name: "dsc.create", schema: CreateDscSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: client, error: clientError } = await ctx.supabase.from("clients").select("id, deleted_at").eq("id", input.clientId).maybeSingle();
    throwIfDbError(clientError);
    if (!client || client.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
    const custody = custodyValue(input.custodyKind, input.custodyName);
    const { data, error } = await ctx.supabase
      .from("dsc_records")
      .insert({
        client_id: input.clientId,
        holder_name: input.holderName,
        holder_pan: input.holderPan,
        dsc_class: input.dscClass,
        serial_number: input.serialNumber,
        issued_by: input.issuedBy,
        issue_date: input.issueDate,
        expiry_date: input.expiryDate,
        custody,
        status: input.status,
        notes: input.notes,
      })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = (data as { id: string }).id;
    await ctx.audit({ event: "data_create", resourceType: "dsc_record", resourceId: id, details: { client_id: input.clientId, holder_name: input.holderName, expiry_date: input.expiryDate, custody } });
    ctx.after("Add the DSC to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "dsc_added",
        title: `DSC of ${input.holderName} added, expires ${formatDate(input.expiryDate)}${custody ? `; held by ${custodyLabel(custody)}` : ""}`,
        metadata: { dsc_id: id },
      }),
    );
    return ok({ id }, expiryWarning(input.expiryDate, input.status));
  },
);

export const updateDsc = defineAction(
  { name: "dsc.update", schema: UpdateDscSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("dsc_records").select("id, client_id, holder_name, expiry_date, custody, status, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That DSC no longer exists. Reload to see the register.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const custody = custodyValue(input.custodyKind, input.custodyName);
    const { data, error } = await ctx.supabase
      .from("dsc_records")
      .update({
        holder_name: input.holderName,
        holder_pan: input.holderPan,
        dsc_class: input.dscClass,
        serial_number: input.serialNumber,
        issued_by: input.issuedBy,
        issue_date: input.issueDate,
        expiry_date: input.expiryDate,
        custody,
        status: input.status,
        notes: input.notes,
      })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    throwIfDbError(error);
    const row = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!row) return fail(STALE, { code: "conflict" });
    const changed: string[] = [];
    if (before.expiry_date !== input.expiryDate) changed.push("expiry date");
    if ((before.custody ?? null) !== custody) changed.push("custody");
    if (before.status !== input.status) changed.push("status");
    if (before.holder_name !== input.holderName) changed.push("holder");
    await ctx.audit({ event: "data_update", resourceType: "dsc_record", resourceId: row.id, details: { client_id: before.client_id, changed, custody, status: input.status } });
    if (changed.length) {
      ctx.after("Add the change to the client's timeline", () =>
        addTimelineEvent({
          clientId: before.client_id,
          eventType: "dsc_updated",
          title: `DSC of ${input.holderName} updated (${changed.join(", ")})${changed.includes("custody") && custody ? `; now held by ${custodyLabel(custody)}` : ""}`,
          metadata: { dsc_id: row.id, changed },
        }),
      );
    }
    return ok({ id: row.id, updatedAt: row.updated_at }, expiryWarning(input.expiryDate, input.status));
  },
);

export const deleteDsc = defineAction(
  { name: "dsc.delete", schema: RecordRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("dsc_records").select("id, client_id, holder_name, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That DSC has already been removed.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const { data, error } = await ctx.supabase.from("dsc_records").delete().eq("id", input.id).eq("updated_at", input.updatedAt).select("id");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_delete", resourceType: "dsc_record", resourceId: input.id, details: { client_id: before.client_id, holder_name: before.holder_name } });
    ctx.after("Add the removal to the client's timeline", () =>
      addTimelineEvent({ clientId: before.client_id, eventType: "dsc_removed", title: `DSC of ${before.holder_name} removed from the register`, metadata: { dsc_id: input.id } }),
    );
    return ok({ id: input.id });
  },
);
