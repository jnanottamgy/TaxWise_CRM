"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { AUDIT_TYPE_LABELS } from "@/lib/domain/audit-stages";
import { DeletePreviousAuditorSchema, PreviousAuditorSchema } from "@/lib/schemas/audits";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity } from "@/server/activity";

/**
 * Communication with the previous auditor (CA Act 1949, First Schedule, Part I, Clause 8; §6.8):
 * before accepting an audit where another CA held the position, the firm writes to the outgoing
 * auditor and keeps proof of delivery; the reply (or its absence) is recorded. Partners and Managers
 * (RLS 0033). The 0195 guard checks the proof is one of the client's documents, the dates, and that
 * a letter in an archived audit file stays read-only. A letter with proof of delivery opens the
 * acceptance gate of the client's engagement of that type (0196).
 */

const MANAGERS = ["partner", "manager"] as const;

function fieldOf(message: string): string | null {
  if (/proof of delivery/i.test(message)) return "deliveryProofDocumentId";
  if (/reply/i.test(message)) return "replyReceivedOn";
  if (/letter can't have been sent/i.test(message)) return "letterSentOn";
  if (/audit engagement/i.test(message)) return "auditEngagementId";
  return null;
}

export const savePreviousAuditorComm = defineAction(
  { name: "previous_auditor.save", schema: PreviousAuditorSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string; created: boolean }>> => {
    if (input.letterSentOn > todayIST()) return fail("The letter can't have been sent in the future.", { code: "validation", fieldErrors: { letterSentOn: ["Enter the date it was sent."] } });
    if (input.replyReceivedOn && input.replyReceivedOn > todayIST()) return fail("The reply can't have arrived in the future.", { code: "validation", fieldErrors: { replyReceivedOn: ["Enter the date it arrived."] } });
    const values = {
      client_id: input.clientId,
      audit_engagement_id: input.auditEngagementId,
      engagement_type: input.engagementType,
      previous_auditor_name: input.previousAuditorName,
      previous_auditor_frn: input.previousAuditorFrn,
      letter_sent_on: input.letterSentOn,
      sent_via: input.sentVia,
      delivery_proof_document_id: input.deliveryProofDocumentId,
      reply_received_on: input.replyReceivedOn,
      objections: input.objections,
      outcome: input.outcome,
      notes: input.notes,
    };
    const created = !input.id;
    let row: { id: string; updated_at: string } | undefined;
    if (input.id) {
      if (!input.updatedAt) return fail("Reload the page and try again.", { code: "conflict" });
      const { data, error } = await ctx.supabase.from("previous_auditor_communications").update(values).eq("id", input.id).eq("updated_at", input.updatedAt).select("id, updated_at");
      if (error?.message?.startsWith("USER: ")) {
        const field = fieldOf(error.message);
        throw new ActionError(error.message.slice(6), field ? { fieldErrors: { [field]: [error.message.slice(6)] } } : {});
      }
      throwIfDbError(error);
      if (!data?.length) return fail("This letter was changed by someone else. Reload to see their changes.", { code: "conflict" });
      row = data[0];
    } else {
      const { data, error } = await ctx.supabase.from("previous_auditor_communications").insert(values).select("id, updated_at").single();
      if (error?.message?.startsWith("USER: ")) {
        const field = fieldOf(error.message);
        throw new ActionError(error.message.slice(6), field ? { fieldErrors: { [field]: [error.message.slice(6)] } } : {});
      }
      throwIfDbError(error);
      row = data!;
    }
    await ctx.audit({
      event: created ? "data_create" : "data_update",
      resourceType: "previous_auditor_communication",
      resourceId: row.id,
      details: { client_id: input.clientId, audit_engagement_id: input.auditEngagementId, proof_of_delivery: Boolean(input.deliveryProofDocumentId), outcome: input.outcome },
    });
    const label = AUDIT_TYPE_LABELS[input.engagementType];
    ctx.after("Add it to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: created ? "previous_auditor_letter_sent" : "previous_auditor_letter_updated",
        title: created ? `Letter to the previous auditor, ${input.previousAuditorName}, sent on ${formatDate(input.letterSentOn)}` : `Previous auditor's letter updated (${input.previousAuditorName})`,
        description: `${label}. ${input.deliveryProofDocumentId ? "Proof of delivery filed." : "Proof of delivery still to file."}${input.replyReceivedOn ? ` Reply received ${formatDate(input.replyReceivedOn)}.` : ""}`,
        metadata: { previous_auditor_communication_id: row.id, audit_engagement_id: input.auditEngagementId },
      }),
    );
    if (input.auditEngagementId) {
      ctx.after("Record it in the engagement's history", () =>
        logActivity({
          entityType: "audit_engagement",
          entityId: input.auditEngagementId!,
          action: "audit_previous_auditor",
          description: `Letter to ${input.previousAuditorName} ${created ? "recorded" : "updated"}${input.deliveryProofDocumentId ? ", with proof of delivery" : ""}`,
        }),
      );
    }
    return ok({ id: row.id, updatedAt: row.updated_at, created });
  },
);

export const deletePreviousAuditorComm = defineAction(
  { name: "previous_auditor.delete", schema: DeletePreviousAuditorSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: existing, error: readError } = await ctx.supabase.from("previous_auditor_communications").select("id, client_id, previous_auditor_name").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!existing) return fail("That letter no longer exists.", { code: "not_found" });
    const { error, count } = await ctx.supabase.from("previous_auditor_communications").delete({ count: "exact" }).eq("id", input.id);
    throwIfDbError(error);
    if (!count) return fail("That letter no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "previous_auditor_communication", resourceId: input.id, details: { client_id: existing.client_id } });
    ctx.after("Add it to the client's timeline", () =>
      addTimelineEvent({ clientId: existing.client_id, eventType: "previous_auditor_letter_removed", title: `Letter to ${existing.previous_auditor_name} removed`, metadata: { previous_auditor_communication_id: input.id } }),
    );
    return ok({ id: input.id });
  },
);
