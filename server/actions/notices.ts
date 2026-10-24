"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { formatDate } from "@/lib/format";
import { getStatus } from "@/lib/status";
import type { NoticeStatus } from "@/lib/domain/enums";
import type { Json } from "@/lib/database.types";
import type { ComboOption } from "@/components/app/form/combobox";
import {
  APPEAL_FORUM_LABEL,
  AttachNoticeDocumentsSchema,
  DetachNoticeDocumentSchema,
  NOTICE_DOCUMENT_KIND_LABEL,
  NoticeClientSearchSchema,
  NoticeFormSchema,
  NoticeNoteSchema,
  NoticeRefSchema,
  NoticeStatusSchema,
  isClosed,
  noticePayload,
  statusPayload,
  type NoticeAppealForum,
} from "@/lib/schemas/notices";
import { searchNoticeClients as searchClients } from "@/lib/data/notices";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * The notices and litigation register (§7.8.4). Staff for their own clients (RLS: Employees see
 * only theirs, §4.1). The database is the real control: save_tax_notice (invoker, RLS) and its guard
 * limit what an Employee changes; set_tax_notice_status runs the workflow, records the appeal
 * decision and creates the appeal task; the log trigger writes the dated lines for moved dates.
 *
 *   saveNotice            log or edit a notice (§13 concurrency check)
 *   setNoticeStatus       Open → Reply drafted → Replied → Hearing → Closed, reopening (Partner/Manager)
 *   addNoticeNote / deleteNoticeNote (Partner/Manager)    the running log
 *   attachNoticeDocuments / detachNoticeDocument          the notice, the reply and the order
 *   deleteNotice          Partner/Manager, for a notice logged by mistake
 *
 * Each writes an audit row; the client's timeline, the record's history and the notices to the
 * people involved run after the save (ctx.after) and never fail it (§0.1 rule 5).
 */

const MP = ["partner", "manager"] as const;

function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

function history(id: string, action: string, description: string) {
  return () => logActivity({ entityType: "tax_notice", entityId: id, action, description });
}

type NoticeHead = { id: string; client_id: string; notice_type: string; reference_no: string | null; reply_due_date: string | null; clients: { display_name: string } | null };

async function noticeHead(ctx: ActionContext, id: string): Promise<NoticeHead> {
  const { data, error } = await ctx.supabase.from("tax_notices").select("id, client_id, notice_type, reference_no, reply_due_date, clients!inner(display_name)").eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That notice no longer exists, or isn't one of yours.", { code: "not_found" });
  return data as unknown as NoticeHead;
}

/** employees.id → profiles.id, for notifying a person by their login. */
async function profileOf(ctx: ActionContext, employeeId: string | null): Promise<string | null> {
  if (!employeeId) return null;
  const { data } = await ctx.supabase.from("employee_directory").select("profile_id").eq("id", employeeId).maybeSingle();
  return (data?.profile_id as string | null) ?? null;
}

export const searchNoticeClients = defineAction(
  { name: "notices.search_clients", schema: NoticeClientSearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchClients(ctx.supabase, input.q)),
);

// =================================================================================================
// Log or edit a notice
// =================================================================================================

export const saveNotice = defineAction(
  { name: "notices.save", schema: NoticeFormSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string; created: boolean }>> => {
    const creating = !input.id;
    if (!creating && !input.updated_at) return fail("Reload the notice and try again.", { code: "conflict" });
    const { data, error } = await ctx.supabase.rpc("save_tax_notice", { p_payload: noticePayload(input, { creating }) as unknown as Json });
    throwDb(error);
    const r = (data ?? {}) as { id: string; updated_at: string; client_id: string; created: boolean; assigned_employee_id: string | null; previous_assigned_employee_id: string | null };

    await ctx.audit({
      event: creating ? "data_create" : "data_update",
      resourceType: "tax_notice",
      resourceId: r.id,
      action: creating ? "notices.create" : "notices.update",
      details: { client_id: r.client_id, notice_type: input.notice_type, reply_due_date: input.reply_due_date, assigned_employee_id: r.assigned_employee_id },
    });

    const due = formatDate(input.reply_due_date);
    if (creating) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId: r.client_id,
          eventType: "notice_logged",
          title: `Notice logged: ${input.notice_type}${input.reference_no ? ` (${input.reference_no})` : ""}, reply due ${due}`,
          metadata: { tax_notice_id: r.id, notice_type: input.notice_type, reply_due_date: input.reply_due_date },
        }),
      );
      ctx.after("Add to your activity", () =>
        logEmployeeActivity({ activityType: "notice_logged", description: `Logged a notice: ${input.notice_type}`, entityType: "tax_notice", entityId: r.id }),
      );
    } else {
      ctx.after("Record it in the notice's history", history(r.id, "notice_updated", "Details updated."));
    }
    if (r.assigned_employee_id && r.assigned_employee_id !== r.previous_assigned_employee_id) {
      ctx.after(
        "Tell the person it's assigned to",
        async () => {
          const profile = await profileOf(ctx, r.assigned_employee_id);
          if (!profile || profile === ctx.user.id) return;
          const head = await noticeHead(ctx, r.id);
          await notify({
            to: { userIds: [profile] },
            type: "info",
            title: `Notice assigned to you: ${head.notice_type}`,
            body: `${head.clients?.display_name ?? "A client"}: reply due ${due}. Assigned by ${ctx.user.fullName}.`,
            linkUrl: `/workpapers/notices/${r.id}`,
            entity: { type: "tax_notice", id: r.id },
            clientId: r.client_id,
            dedupeKey: `notice_assigned:${r.id}:${r.assigned_employee_id}:${r.updated_at}`,
          });
        },
        "The person it's assigned to wasn't notified. Tell them about the notice.",
      );
    }
    return ok({ id: r.id, updatedAt: r.updated_at, created: Boolean(r.created) });
  },
);

// =================================================================================================
// The workflow (§7.8.4)
// =================================================================================================

export type NoticeStatusResult = {
  status: NoticeStatus;
  updatedAt: string;
  appealTaskId: string | null;
  taskCreated: boolean;
  limitationDate: string | null;
};

export const setNoticeStatus = defineAction(
  { name: "notices.status", schema: NoticeStatusSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<NoticeStatusResult>> => {
    const { data, error } = await ctx.supabase.rpc("set_tax_notice_status", {
      p_id: input.id,
      p_updated_at: input.updatedAt,
      p_status: input.status,
      p_payload: statusPayload(input) as unknown as Json,
    });
    throwDb(error);
    const r = (data ?? {}) as {
      status: NoticeStatus;
      from_status: NoticeStatus;
      updated_at: string;
      client_id: string;
      appeal_task_id: string | null;
      task_created: boolean;
      task_assignee_id: string | null;
      limitation_date: string | null;
      appeal_decision: "appeal" | "no_appeal" | null;
    };
    const to = getStatus("notice_status", r.status).label;
    const from = getStatus("notice_status", r.from_status).label;
    const forum = input.appeal_forum ? APPEAL_FORUM_LABEL[input.appeal_forum as NoticeAppealForum] : null;

    await ctx.audit({
      event: "data_update",
      resourceType: "tax_notice",
      resourceId: input.id,
      action: "notices.status",
      details: {
        from: r.from_status,
        to: r.status,
        appeal_decision: r.appeal_decision,
        appeal_forum: input.appeal_forum || null,
        limitation_date: r.limitation_date,
        appeal_task_id: r.appeal_task_id,
        note: input.note || null,
      },
    });

    const head = await noticeHead(ctx, input.id).catch(() => null);
    const what = r.from_status === r.status ? "Appeal details updated" : `${from} → ${to}`;
    ctx.after("Record it in the notice's history", history(input.id, "notice_status", `${what}.`));
    if (r.from_status !== r.status && (isClosed(r.status) || isClosed(r.from_status))) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId: r.client_id,
          eventType: isClosed(r.status) ? "notice_closed" : "notice_reopened",
          title: isClosed(r.status)
            ? `Notice ${head?.notice_type ?? ""} closed: ${to.replace(/^Closed /, "").replace(/[()]/g, "")}${r.appeal_decision === "appeal" && r.limitation_date ? `; appeal by ${formatDate(r.limitation_date)}` : ""}`
            : `Notice ${head?.notice_type ?? ""} reopened`,
          metadata: { tax_notice_id: input.id, status: r.status, appeal_decision: r.appeal_decision, limitation_date: r.limitation_date },
        }),
      );
    }
    if (r.task_created && r.appeal_task_id) {
      ctx.after(
        "Tell the person who files the appeal",
        async () => {
          const profile = await profileOf(ctx, r.task_assignee_id);
          await notify({
            to: profile ? { userIds: [profile] } : { roles: ["manager"] },
            type: "task_assigned",
            title: profile ? "Appeal task assigned to you" : "Appeal task needs an assignee",
            body: `${head?.clients?.display_name ?? "A client"}: appeal against the ${head?.notice_type ?? "notice"} order${forum ? ` to ${forum}` : ""}, limitation date ${r.limitation_date ? formatDate(r.limitation_date) : "not set"}.`,
            linkUrl: `/work/${r.appeal_task_id}`,
            entity: { type: "task", id: r.appeal_task_id as string },
            clientId: r.client_id,
            dedupeKey: `notice_appeal_task:${r.appeal_task_id}`,
          });
        },
        "The appeal task was created, but nobody was notified. Tell the person who will file it.",
      );
      ctx.after("Record the task on the notice", history(input.id, "appeal_task_created", "Appeal task created."));
    }
    return ok({ status: r.status, updatedAt: r.updated_at, appealTaskId: r.appeal_task_id, taskCreated: Boolean(r.task_created), limitationDate: r.limitation_date });
  },
);

// =================================================================================================
// The running log (§7.8.4 "Running notes log (dated entries)")
// =================================================================================================

export const addNoticeNote = defineAction(
  { name: "notices.add_note", schema: NoticeNoteSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const head = await noticeHead(ctx, input.notice_id);
    const { data, error } = await ctx.supabase
      .from("tax_notice_notes")
      .insert({ notice_id: input.notice_id, client_id: head.client_id, noted_on: input.noted_on, body: input.body, kind: "note", author_id: ctx.user.id })
      .select("id")
      .single();
    throwIfDbError(error);
    if (!data) return fail("The note wasn't saved. Reload the notice and try again.", { code: "unexpected" });
    await ctx.audit({ event: "data_create", resourceType: "tax_notice_note", resourceId: data.id, action: "notices.add_note", details: { tax_notice_id: input.notice_id, noted_on: input.noted_on } });
    return ok({ id: data.id });
  },
);

export const deleteNoticeNote = defineAction(
  { name: "notices.delete_note", schema: NoticeRefSchema, roles: MP },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("tax_notice_notes").delete().eq("id", input.id).select("id, notice_id, body");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That note no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "tax_notice_note", resourceId: input.id, action: "notices.delete_note", details: { tax_notice_id: data[0].notice_id, body: data[0].body.slice(0, 200) } });
    ctx.after("Record it in the notice's history", history(data[0].notice_id, "note_removed", "A log line was removed."));
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Attachments: the notice, the reply and the order (through the documents vault)
// =================================================================================================

export const attachNoticeDocuments = defineAction(
  { name: "notices.attach", schema: AttachNoticeDocumentsSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ attached: number }>> => {
    const head = await noticeHead(ctx, input.notice_id);
    const { data: docs, error: docError } = await ctx.supabase.from("documents").select("id").in("id", input.document_ids).eq("client_id", head.client_id).is("deleted_at", null);
    throwIfDbError(docError);
    if ((docs ?? []).length !== input.document_ids.length) return fail("Some of those documents aren't in this client's vault.", { code: "validation" });
    const { data: existing, error: exError } = await ctx.supabase.from("tax_notice_documents").select("document_id").eq("notice_id", input.notice_id).in("document_id", input.document_ids);
    throwIfDbError(exError);
    const already = new Set((existing ?? []).map((e) => e.document_id));
    const rows = input.document_ids.filter((d) => !already.has(d)).map((document_id) => ({ notice_id: input.notice_id, document_id, kind: input.kind }));
    if (rows.length) {
      const { error } = await ctx.supabase.from("tax_notice_documents").insert(rows);
      throwIfDbError(error);
    }
    await ctx.audit({ event: "data_create", resourceType: "tax_notice_document", resourceId: input.notice_id, action: "notices.attach", details: { document_ids: rows.map((r) => r.document_id), kind: input.kind } });
    if (rows.length && (input.kind === "order" || input.kind === "notice")) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId: head.client_id,
          eventType: "notice_document_added",
          title: `${NOTICE_DOCUMENT_KIND_LABEL[input.kind]} attached to the ${head.notice_type} notice`,
          metadata: { tax_notice_id: input.notice_id },
        }),
      );
    }
    return ok({ attached: rows.length });
  },
);

export const detachNoticeDocument = defineAction(
  { name: "notices.detach", schema: DetachNoticeDocumentSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("tax_notice_documents").delete().eq("id", input.id).select("id, notice_id, document_id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That attachment no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "tax_notice_document", resourceId: input.id, action: "notices.detach", details: { tax_notice_id: data[0].notice_id, document_id: data[0].document_id } });
    ctx.after("Record it in the notice's history", history(data[0].notice_id, "attachment_removed", "An attachment was removed (the file stays in the client's documents)."));
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Delete (a notice logged by mistake; Partner/Manager, RLS)
// =================================================================================================

export const deleteNotice = defineAction(
  { name: "notices.delete", schema: NoticeRefSchema, roles: MP },
  async (input, ctx): Promise<ActionResult<{ clientId: string }>> => {
    const head = await noticeHead(ctx, input.id);
    const { data, error } = await ctx.supabase.from("tax_notices").delete().eq("id", input.id).select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That notice no longer exists.", { code: "not_found" });
    await ctx.audit({
      event: "data_delete",
      resourceType: "tax_notice",
      resourceId: input.id,
      action: "notices.delete",
      details: { client_id: head.client_id, notice_type: head.notice_type, reference_no: head.reference_no, reply_due_date: head.reply_due_date },
    });
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({ clientId: head.client_id, eventType: "notice_deleted", title: `Notice ${head.notice_type} removed from the register`, metadata: { notice_type: head.notice_type } }),
    );
    return ok({ clientId: head.client_id });
  },
);
