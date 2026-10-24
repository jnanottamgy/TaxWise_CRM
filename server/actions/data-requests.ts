"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { DATA_REQUEST_STATUS_INFO, DATA_REQUEST_TYPE_LABELS, isClosedRequestStatus } from "@/lib/domain/dpdp";
import { DataRequestSchema, DataRequestStatusSchema } from "@/lib/schemas/dpdp";
import { logActivity } from "@/server/activity";
import { notify } from "@/server/notify";

/**
 * Data principals' requests under the DPDP Act 2023 (§6.10 "data_requests handles access,
 * correction, erasure, grievance and nomination, with due dates and status; staff see them in the
 * Inbox"). Partners record and answer them (§7.15.4 "Partner; Managers read-only"; RLS 0197). The
 * database sets the due date from the type (dpdp.request_response_days) and refuses to close a
 * request without the response, or an erasure without what statutory retention keeps back and why
 * (0197 guard). Closed states are completed, resolved, rejected and withdrawn; the inbox and every
 * count treat the rest as open.
 *
 * The requester's name and contact are personal data: they stay in the request (Partners and
 * Managers only) and are never copied into audit rows, the client timeline or notices.
 */

const PARTNER = ["partner"] as const;
const STALE = "This request was changed by someone else. Reload to see their changes.";

/** received_at for a date typed in: now when it is today, otherwise the start of that IST day. */
function receivedAt(receivedOn: string): string {
  return receivedOn === todayIST() ? new Date().toISOString() : new Date(`${receivedOn}T00:00:00+05:30`).toISOString();
}

function dbFieldError(error: { message?: string } | null): void {
  const msg = error?.message ?? "";
  if (!msg.startsWith("USER: ")) return;
  const text = msg.slice(6);
  if (/received/i.test(text)) throw new ActionError(text, { fieldErrors: { receivedOn: [text] } });
  if (/due date/i.test(text)) throw new ActionError(text, { fieldErrors: { receivedOn: [text] } });
  if (/response/i.test(text)) throw new ActionError(text, { fieldErrors: { response: [text] } });
  if (/retained/i.test(text)) throw new ActionError(text, { fieldErrors: { retainedExplanation: [text] } });
}

export const saveDataRequest = defineAction(
  { name: "data_requests.save", schema: DataRequestSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string; dueBy: string | null }>> => {
    if (input.receivedOn > todayIST()) return fail("The request can't have been received in the future.", { code: "validation", fieldErrors: { receivedOn: ["Pick today or an earlier date."] } });
    if (input.clientId) {
      const { data: client, error: clientError } = await ctx.supabase.from("clients").select("id").eq("id", input.clientId).is("deleted_at", null).maybeSingle();
      throwIfDbError(clientError);
      if (!client) return fail("That client isn't in the client list.", { code: "validation", fieldErrors: { clientId: ["Choose a current client, or leave it blank."] } });
    }
    const values = {
      subject: input.subject,
      subject_type: input.subjectType,
      contact: input.contact,
      client_id: input.clientId,
      type: input.type,
      channel: input.channel,
      details: input.details,
      handled_by: input.handledBy,
    };

    if (input.id) {
      if (!input.updatedAt) return fail(STALE, { code: "conflict" });
      const { data: current, error: readError } = await ctx.supabase.from("data_requests").select("id, status, received_at, type").eq("id", input.id).maybeSingle();
      throwIfDbError(readError);
      if (!current) return fail("That request no longer exists.", { code: "not_found" });
      if (isClosedRequestStatus(current.status)) return fail("This request is closed. Reopen it to change its details.", { code: "blocked" });
      // Keep the stored time when the day is unchanged; a new day moves the due date with it (0197).
      const patch = formatInputDay(current.received_at) === input.receivedOn ? values : { ...values, received_at: receivedAt(input.receivedOn) };
      const { data, error } = await ctx.supabase.from("data_requests").update(patch).eq("id", input.id).eq("updated_at", input.updatedAt).select("id, updated_at, due_by");
      dbFieldError(error);
      throwIfDbError(error);
      if (!data?.length) return fail(STALE, { code: "conflict" });
      await ctx.audit({ event: "data_update", resourceType: "data_request", resourceId: input.id, details: { type: input.type, subject_type: input.subjectType, due_by: data[0].due_by } });
      ctx.after("Record it in the request's history", () =>
        logActivity({ entityType: "data_request", entityId: input.id!, action: "data_request_updated", description: `Details updated by ${ctx.user.fullName}` }),
      );
      return ok({ id: data[0].id, updatedAt: data[0].updated_at, dueBy: data[0].due_by });
    }

    const { data, error } = await ctx.supabase
      .from("data_requests")
      .insert({ ...values, received_at: receivedAt(input.receivedOn), status: "open" })
      .select("id, updated_at, due_by")
      .single();
    dbFieldError(error);
    throwIfDbError(error);
    const row = data!;
    await ctx.audit({ event: "data_create", resourceType: "data_request", resourceId: row.id, details: { type: input.type, subject_type: input.subjectType, channel: input.channel, due_by: row.due_by } });
    ctx.after("Record it in the request's history", () =>
      logActivity({ entityType: "data_request", entityId: row.id, action: "data_request_received", description: `${DATA_REQUEST_TYPE_LABELS[input.type]} request recorded by ${ctx.user.fullName}` }),
    );
    ctx.after("Tell the Partners", () =>
      notify({
        to: { roles: ["partner"] },
        type: "info",
        title: `Data request received: ${DATA_REQUEST_TYPE_LABELS[input.type].toLowerCase()}`,
        body: `A data principal's ${input.type} request was recorded by ${ctx.user.fullName}${row.due_by ? `. Answer it by ${formatDate(row.due_by)}` : ""}.`,
        linkUrl: `/quality?tab=data-requests&request=${row.id}`,
        entity: { type: "data_request", id: row.id },
        dedupeKey: `data_request_received:${row.id}`,
      }),
    );
    return ok({ id: row.id, updatedAt: row.updated_at, dueBy: row.due_by });
  },
);

/** The IST day an ISO timestamp falls on, as the date input shows it. */
function formatInputDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export const setDataRequestStatus = defineAction(
  { name: "data_requests.status", schema: DataRequestStatusSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; closed: boolean }>> => {
    const { data: current, error: readError } = await ctx.supabase.from("data_requests").select("id, type, status, handled_by").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!current) return fail("That request no longer exists.", { code: "not_found" });
    if (current.type !== input.type) return fail(STALE, { code: "conflict" });
    if (current.status === input.status && !isClosedRequestStatus(input.status)) return fail(`The request is already ${DATA_REQUEST_STATUS_INFO[input.status].label.toLowerCase()}.`, { code: "blocked" });
    const closing = isClosedRequestStatus(input.status);
    const patch = {
      status: input.status,
      response: input.response,
      retained_explanation: current.type === "erasure" ? input.retainedExplanation : null,
      handled_by: current.handled_by ?? ctx.user.id,
    };
    const { data, error } = await ctx.supabase.from("data_requests").update(patch).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at, closed_at");
    dbFieldError(error);
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    const label = DATA_REQUEST_STATUS_INFO[input.status].label;
    await ctx.audit({
      event: "data_update",
      resourceType: "data_request",
      resourceId: input.id,
      action: closing ? "data_requests.close" : "data_requests.status",
      details: { from: current.status, to: input.status, retained_recorded: Boolean(patch.retained_explanation) },
    });
    ctx.after("Record it in the request's history", () =>
      logActivity({
        entityType: "data_request",
        entityId: input.id,
        action: closing ? "data_request_closed" : "data_request_status",
        description: `${label} by ${ctx.user.fullName}${isClosedRequestStatus(current.status) && !closing ? " (reopened)" : ""}`,
        metadata: { from: current.status, to: input.status },
      }),
    );
    return ok({ updatedAt: data[0].updated_at, closed: closing });
  },
);
