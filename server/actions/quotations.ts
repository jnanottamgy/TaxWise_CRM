"use server";

import { createElement } from "react";
import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { env } from "@/lib/env";
import { formatDate, formatTime } from "@/lib/format";
import { todayIST } from "@/lib/domain/fy";
import { formatINR, toPaise, toPaiseOrNull } from "@/lib/domain/money";
import { quotationNeedsApproval } from "@/lib/domain/approvals";
import { isAppRole, type AppRole } from "@/lib/auth/roles";
import type { EmailSendOutcome } from "@/lib/handoff";
import {
  ApprovalDecisionSchema,
  CHANNEL_SEND_LABELS,
  QUOTATION_FILTERS,
  QUOTATION_SORTABLE,
  FollowUpEmailSchema,
  QuotationDraftSchema,
  QuotationHandoffSchema,
  QuotationRefSchema,
  SendQuotationEmailSchema,
  followUpTone,
  type QuotationDraftData,
} from "@/lib/schemas/quotations";
import {
  getQuotationDocument,
  listQuotations,
  prefillFromClient,
  prefillFromLead,
  searchClientsForQuotation,
  searchLeadsForQuotation,
  type BuilderPrefill,
  type PartyOption,
} from "@/lib/data/quotations";
import type { ServerSupabase } from "@/lib/supabase/server";
import { parseTableParams } from "@/components/app/data-table/params";
import { toCsv } from "@/lib/schemas/clients";
import { getStatus } from "@/lib/status";
import { getFirmProfile } from "@/server/firm";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";
import { sendEmail } from "@/server/email/send";
import { emailFirm, quotationFollowUpEmail, quotationSentEmail } from "@/server/email/templates";
import { loadFirmLogo, pdfFileName, renderPdf } from "@/server/pdf";
import { QuotationPdf } from "@/server/pdf/quotation";

/**
 * Quotations (§7.5.2–§7.5.3), Partner/Manager only (§4.1; RLS and the 0143/0144 functions refuse
 * anyone else). Every step runs one database function under the person's session, so the approval
 * gate (quotations_role_guard), the Draft-only editing and the workflow's moves
 * (quotations_status_guard) hold whatever calls them. Concurrency: each step carries the
 * updated_at the person loaded and is refused, never overwritten, when the row moved on (§13).
 *
 *   saveQuotationDraft          the builder's autosave and Save draft (creates the Draft on first save)
 *   submitQuotationForApproval  a Manager's quotation over the limit → Pending approval; Partners told
 *   decideQuotationApproval     Partner: Approve, or Return with comments (Approve & send = approve, then send)
 *   sendQuotationEmail          the branded email with View quotation (/q/<token>) and the PDF attached
 *   logQuotationHandoff         Gmail / WhatsApp hand-off or a copied link: records the send or follow-up
 *   sendQuotationFollowUp       a day-N follow-up by email, now
 *   reviseQuotation             a new Draft revision; the old one Superseded
 *   deleteQuotation             to the recycle bin (never an accepted one)
 */

const PM = ["partner", "manager"] as const;
const PARTNER = ["partner"] as const;

/** Database refusals: 'USER: CONFLICT: …' (the row moved on) becomes a conflict result. */
function throwDb(error: { code?: string; message?: string; details?: string } | null): void {
  if (error?.message?.startsWith("USER: CONFLICT: ")) {
    throw new ActionError(error.message.slice("USER: CONFLICT: ".length), { code: "conflict" });
  }
  throwIfDbError(error);
}

function appUrl(): string {
  return env.appUrl().replace(/\/+$/, "");
}

type Loaded = {
  id: string;
  quotation_number: string;
  status: string;
  token: string;
  lead_id: string | null;
  client_id: string | null;
  client_name: string;
  client_company: string | null;
  client_email: string;
  valid_until: string;
  total: number;
  sent_at: string | null;
  updated_at: string;
  created_by: string;
  revised_from_id: string | null;
  revision_number: number;
  approved_at: string | null;
  approval_requested_at: string | null;
  deleted_at: string | null;
};

async function load(supabase: ServerSupabase, id: string): Promise<Loaded> {
  const { data, error } = await supabase
    .from("quotations")
    .select(
      "id, quotation_number, status, token, lead_id, client_id, client_name, client_company, client_email, valid_until, total, sent_at, updated_at, created_by, revised_from_id, revision_number, approved_at, approval_requested_at, deleted_at",
    )
    .eq("id", id)
    .maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("This quotation no longer exists. It may have been deleted.", { code: "not_found" });
  return { ...data, client_email: String(data.client_email), total: Number(data.total) } as Loaded;
}

function stale(updatedAt: string): ActionError {
  return new ActionError(`This quotation was changed at ${formatTime(updatedAt)} on ${formatDate(updatedAt)}. Reload to see the changes.`, { code: "conflict" });
}

async function authorRole(supabase: ServerSupabase, profileId: string): Promise<AppRole | null> {
  const { data, error } = await supabase.from("profiles").select("role").eq("id", profileId).maybeSingle();
  throwIfDbError(error);
  return data && isAppRole(data.role) ? data.role : null;
}

async function approvalLimitPaise(supabase: ServerSupabase) {
  const { data, error } = await supabase.from("firm_settings").select("quotation_approval_limit").eq("id", 1).maybeSingle();
  throwIfDbError(error);
  return toPaiseOrNull(data?.quotation_approval_limit ?? null);
}

/** Refuses sending a quotation the approval gate holds, before anything leaves the building. */
async function assertSendable(supabase: ServerSupabase, q: Loaded): Promise<void> {
  if (q.status === "pending_approval") throw new ActionError("This quotation waits for a Partner's approval before it can be sent.");
  if (!["draft", "approved", "sent", "viewed"].includes(q.status)) {
    throw new ActionError(`This quotation is ${q.status.replace(/_/g, " ")} and can't be sent. Revise it to send a new version.`);
  }
  if (q.valid_until < todayIST()) throw new ActionError("The valid-until date has passed, so the client couldn't accept it. Move the date, or revise the quotation.");
  // The gate judges what the client will see: the lines (the PDF and the public page are drawn from
  // them), not a stored total that could lag behind them.
  const { data: lines, error } = await supabase.from("quotation_items").select("total").eq("quotation_id", q.id).limit(200);
  throwIfDbError(error);
  if (!lines?.length) throw new ActionError("Add at least one line before sending it.");
  if (q.status === "draft") {
    const role = await authorRole(supabase, q.created_by);
    const linesPaise = lines.reduce((sum, l) => sum + toPaise(l.total), 0);
    const totalPaise = Math.max(linesPaise, toPaise(q.total));
    if (quotationNeedsApproval(role ?? "manager", totalPaise, await approvalLimitPaise(supabase))) {
      throw new ActionError("This quotation is over the quotation approval limit. Submit it for a Partner's approval first.");
    }
  }
}

function who(q: Pick<Loaded, "client_company" | "client_name">): string {
  return q.client_company?.trim() || q.client_name;
}

// =================================================================================================
// The builder
// =================================================================================================

function headerFrom(v: QuotationDraftData) {
  return {
    lead_id: v.party === "lead" ? v.lead_id : null,
    client_id: v.party === "client" ? v.client_id : null,
    client_name: v.client_name,
    client_email: v.client_email,
    client_phone: v.client_phone,
    client_company: v.client_company,
    client_gstin: v.client_gstin || null,
    place_of_supply_code: v.place_of_supply_code,
    issue_date: v.issue_date,
    valid_until: v.valid_until,
    notes: v.notes,
    terms: v.terms,
  };
}

export type SavedQuotation = { id: string; quotationNumber: string; updatedAt: string; created: boolean };

export const saveQuotationDraft = defineAction(
  { name: "quotations.save_draft", schema: QuotationDraftSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<SavedQuotation>> => {
    if (input.id && !input.updatedAt) return fail("Reload the quotation before saving it.", { code: "conflict" });
    const items = input.lines.map((l) => ({
      description: l.description,
      service_type: l.service_type,
      frequency: l.frequency,
      quantity: l.quantity,
      unit_price: l.unit_price,
      tax_rate: l.tax_rate,
    }));
    const { data, error } = await ctx.supabase.rpc("save_quotation", {
      p_id: input.id,
      p_expected_updated_at: input.updatedAt,
      p_header: headerFrom(input),
      p_items: items,
    });
    throwDb(error);
    const row = (data ?? [])[0];
    if (!row?.id || !row.updated_at) throw new Error("save_quotation returned nothing");
    if (row.conflict) {
      return fail(`Someone else saved this quotation at ${formatTime(row.updated_at)}. Reload to see their changes; your edits are kept on this device.`, { code: "conflict" });
    }
    const created = !input.id;
    await ctx.audit({
      event: created ? "data_create" : "data_update",
      resourceType: "quotation",
      resourceId: row.id,
      action: "quotations.save_draft",
      details: { quotation_number: row.quotation_number, lines: items.length, total: row.total, lead_id: input.lead_id, client_id: input.client_id },
    });
    if (created) {
      const leadId = input.party === "lead" ? input.lead_id : null;
      const clientId = input.party === "client" ? input.client_id : null;
      if (leadId || clientId) {
        ctx.after("Add to the timeline", () =>
          addTimelineEvent({ leadId, clientId, eventType: "quotation_created", title: `Quotation ${row.quotation_number} started`, metadata: { quotation_id: row.id } }),
        );
      }
      ctx.after("Record the quotation's history", () =>
        logActivity({ entityType: "quotation", entityId: row.id!, action: "quotation_created", description: `Draft started by ${ctx.user.fullName}` }),
      );
    }
    return ok({ id: row.id, quotationNumber: row.quotation_number ?? "", updatedAt: row.updated_at, created });
  },
);

export const searchQuotationParties = defineAction(
  { name: "quotations.search_parties", schema: z.object({ kind: z.enum(["lead", "client"]), q: z.string().trim().max(100).default("") }), roles: PM },
  async (input, ctx): Promise<ActionResult<PartyOption[]>> => {
    const rows = input.kind === "lead" ? await searchLeadsForQuotation(ctx.supabase, input.q) : await searchClientsForQuotation(ctx.supabase, input.q);
    return ok(rows);
  },
);

export const loadQuotationParty = defineAction(
  { name: "quotations.load_party", schema: z.object({ kind: z.enum(["lead", "client"]), id: z.uuid() }), roles: PM },
  async (input, ctx): Promise<ActionResult<BuilderPrefill>> => {
    const p = input.kind === "lead" ? await prefillFromLead(ctx.supabase, input.id) : await prefillFromClient(ctx.supabase, input.id);
    if (!p) return fail(input.kind === "lead" ? "That lead no longer exists." : "That client no longer exists.", { code: "not_found" });
    return ok(p);
  },
);

// =================================================================================================
// Approval (§7.5.2)
// =================================================================================================

export const submitQuotationForApproval = defineAction(
  { name: "quotations.submit_for_approval", schema: QuotationRefSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const q = await load(ctx.supabase, input.id);
    const { data, error } = await ctx.supabase.rpc("submit_quotation_for_approval", { p_id: input.id, p_expected_updated_at: input.updatedAt });
    throwDb(error);
    const row = (data ?? [])[0];
    if (!row?.updated_at) throw new Error("submit_quotation_for_approval returned nothing");
    await ctx.audit({ event: "data_update", resourceType: "quotation", resourceId: q.id, action: "quotations.submit_for_approval", details: { quotation_number: q.quotation_number, total: q.total } });
    ctx.after("Tell the Partners", () =>
      notify({
        to: { roles: ["partner"] },
        type: "info",
        title: `Quotation ${q.quotation_number} needs your approval`,
        body: `${ctx.user.fullName} submitted the quotation for ${who(q)} (${formatINR(toPaise(q.total))} incl. GST).`,
        linkUrl: `/quotations/${q.id}`,
        entity: { type: "quotation", id: q.id },
        clientId: q.client_id,
        dedupeKey: `quotation_approval:${q.id}:${row.updated_at}`,
      }),
      "The Partners weren't told. Let a Partner know it's waiting for approval.",
    );
    ctx.after("Record the quotation's history", () =>
      logActivity({ entityType: "quotation", entityId: q.id, action: "quotation_submitted", description: `Submitted for a Partner's approval by ${ctx.user.fullName}` }),
    );
    return ok({ updatedAt: row.updated_at });
  },
);

export const decideQuotationApproval = defineAction(
  { name: "quotations.decide_approval", schema: ApprovalDecisionSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; status: string }>> => {
    const q = await load(ctx.supabase, input.id);
    const { data, error } = await ctx.supabase.rpc("decide_quotation_approval", {
      p_id: input.id,
      p_expected_updated_at: input.updatedAt,
      p_decision: input.decision,
      p_note: input.note || null,
    });
    throwDb(error);
    const row = (data ?? [])[0];
    if (!row?.updated_at || !row.status) throw new Error("decide_quotation_approval returned nothing");
    const approved = input.decision === "approve";
    await ctx.audit({
      event: "data_update",
      resourceType: "quotation",
      resourceId: q.id,
      action: approved ? "quotations.approve" : "quotations.return",
      details: { quotation_number: q.quotation_number, note: input.note || null },
    });
    if (q.created_by !== ctx.user.id) {
      ctx.after("Tell the author", () =>
        notify({
          to: { userIds: [q.created_by] },
          type: "info",
          title: approved ? `Quotation ${q.quotation_number} approved` : `Quotation ${q.quotation_number} returned with comments`,
          body: approved ? `${ctx.user.fullName} approved it. You can send it to ${who(q)} now.` : `${ctx.user.fullName}: ${input.note}`,
          linkUrl: `/quotations/${q.id}`,
          entity: { type: "quotation", id: q.id },
          clientId: q.client_id,
          dedupeKey: `quotation_decision:${q.id}:${row.updated_at}`,
        }),
      );
    }
    ctx.after("Record the quotation's history", () =>
      logActivity({
        entityType: "quotation",
        entityId: q.id,
        action: approved ? "quotation_approved" : "quotation_returned",
        description: approved ? `Approved by ${ctx.user.fullName}${input.note ? `: ${input.note}` : ""}` : `Returned by ${ctx.user.fullName}: ${input.note}`,
      }),
    );
    return ok({ updatedAt: row.updated_at, status: row.status });
  },
);

// =================================================================================================
// Sending (§7.5.3)
// =================================================================================================

async function renderQuotationPdf(supabase: ServerSupabase, id: string): Promise<{ bytes: Buffer; fileName: string; number: string }> {
  const firm = await getFirmProfile(supabase);
  const doc = await getQuotationDocument(supabase, id, firm.stateCode);
  if (!doc) throw new ActionError("This quotation no longer exists.", { code: "not_found" });
  const logo = await loadFirmLogo(firm).catch(() => null);
  const bytes = await renderPdf(createElement(QuotationPdf, { firm, logo, doc }) as never);
  return { bytes, fileName: pdfFileName(doc.number, "Quotation"), number: doc.number };
}

export type SendResult = { outcome: EmailSendOutcome; updatedAt: string | null; status: string | null };

export const sendQuotationEmail = defineAction(
  { name: "quotations.send_email", schema: SendQuotationEmailSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<SendResult>> => {
    const q = await load(ctx.supabase, input.id);
    if (q.updated_at !== input.updatedAt) throw stale(q.updated_at);
    await assertSendable(ctx.supabase, q);

    const firm = await getFirmProfile(ctx.supabase);
    const pdf = await renderQuotationPdf(ctx.supabase, q.id);
    let revisionOf: string | null = null;
    if (q.revised_from_id) {
      const { data: prev } = await ctx.supabase.from("quotations").select("quotation_number").eq("id", q.revised_from_id).maybeSingle();
      revisionOf = prev?.quotation_number ?? null;
    }
    const mail = quotationSentEmail(
      {
        recipientName: q.client_name,
        quotationNumber: q.quotation_number,
        totalPaise: toPaise(q.total),
        validUntil: q.valid_until,
        viewUrl: `${appUrl()}/q/${q.token}`,
        coveringNote: input.coveringNote || null,
        preparedByName: ctx.user.fullName,
        revisionOf,
      },
      emailFirm(firm),
    );
    const { count: priorSends } = await ctx.supabase
      .from("quotation_email_logs")
      .select("id", { count: "exact", head: true })
      .eq("quotation_id", q.id)
      .eq("channel", "email")
      .in("email_type", ["initial", "revision"])
      .in("status", ["sent", "delivered", "opened"]);
    const emailType = q.revised_from_id ? "revision" : "initial";
    const recipients = [input.to, ...input.cc.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean)];
    const sent = await sendEmail({
      to: recipients,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "quotation_sent",
      clientId: q.client_id,
      related: { type: "quotation", id: q.id },
      attachments: [{ filename: pdf.fileName, content: pdf.bytes, contentType: "application/pdf" }],
      idempotencyKey: `quotation:${q.id}:send:${priorSends ?? 0}`,
    });

    if (sent.status !== "sent") {
      if (sent.status === "failed") {
        const { error: logErr } = await ctx.supabase
          .from("quotation_email_logs")
          .insert({ quotation_id: q.id, channel: "email", email_type: emailType, to: recipients.join(", "), subject: mail.subject, status: "failed", error: sent.error ?? null });
        if (logErr) throwIfDbError(logErr);
      }
      await ctx.audit({
        event: "data_update",
        resourceType: "quotation",
        resourceId: q.id,
        action: "quotations.send_email",
        success: false,
        error: sent.error ?? sent.status,
        details: { quotation_number: q.quotation_number, to: recipients },
      });
      return ok({ outcome: { status: sent.status, error: sent.error }, updatedAt: null, status: null });
    }

    const { data, error } = await ctx.supabase.rpc("mark_quotation_sent", {
      p_id: q.id,
      p_expected_updated_at: null,
      p_channel: "email",
      p_to: recipients.join(", "),
      p_subject: mail.subject,
      p_provider_message_id: sent.providerMessageId ?? null,
      p_email_type: emailType,
    });
    if (error) {
      // The email went; say so, and what didn't happen.
      return ok(
        { outcome: { status: "sent" }, updatedAt: null, status: null },
        [`Emailed, but the quotation couldn't be marked as sent (${error.message?.replace(/^USER:\s*/, "") ?? "database error"}). Reload the page.`],
      );
    }
    const row = (data ?? [])[0];
    await ctx.audit({
      event: "data_update",
      resourceType: "quotation",
      resourceId: q.id,
      action: "quotations.send_email",
      details: { quotation_number: q.quotation_number, to: recipients, provider_message_id: sent.providerMessageId ?? null, first_send: row?.first_send ?? null },
    });
    ctx.after("Add to the timeline", () =>
      q.lead_id || q.client_id
        ? addTimelineEvent({
            leadId: q.lead_id,
            clientId: q.client_id,
            eventType: "quotation_sent",
            title: `Quotation ${q.quotation_number} emailed to ${recipients[0]}`,
            metadata: { quotation_id: q.id, total: q.total },
          })
        : Promise.resolve(),
    );
    ctx.after("Record the quotation's history", () =>
      logActivity({ entityType: "quotation", entityId: q.id, action: "quotation_sent", description: `Emailed to ${recipients.join(", ")} by ${ctx.user.fullName}` }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "email_sent", description: `Emailed quotation ${q.quotation_number} to ${who(q)}`, entityType: "quotation", entityId: q.id, entityName: q.quotation_number }),
    );
    return ok({ outcome: { status: "sent" }, updatedAt: row?.updated_at ?? null, status: row?.status ?? null });
  },
);

export const logQuotationHandoff = defineAction(
  { name: "quotations.handoff", schema: QuotationHandoffSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string | null; status: string | null }>> => {
    const q = await load(ctx.supabase, input.id);
    const channelLabel = CHANNEL_SEND_LABELS[input.channel] ?? input.channel;
    let updatedAt: string | null = null;
    let status: string | null = null;

    if (input.followUpDay) {
      if (input.channel === "internal_note") return fail("Follow up by WhatsApp or Gmail.", { code: "validation" });
      const { error } = await ctx.supabase.rpc("record_quotation_follow_up", {
        p_id: q.id,
        p_day: input.followUpDay,
        p_channel: input.channel,
        p_to: input.recipient || null,
        p_subject: input.subject || null,
        p_status: "handed_off",
      });
      throwDb(error);
    } else {
      if (input.updatedAt && q.updated_at !== input.updatedAt && (q.status === "draft" || q.status === "approved")) throw stale(q.updated_at);
      await assertSendable(ctx.supabase, q);
      const { data, error } = await ctx.supabase.rpc("mark_quotation_sent", {
        p_id: q.id,
        p_expected_updated_at: null,
        p_channel: input.channel,
        p_to: input.recipient || null,
        p_subject: input.subject || null,
        p_provider_message_id: null,
        p_email_type: q.revised_from_id ? "revision" : "initial",
      });
      throwDb(error);
      const row = (data ?? [])[0];
      updatedAt = row?.updated_at ?? null;
      status = row?.status ?? null;
    }

    // The client's Communication history (§7.13.1): a handed-off message about a quotation (money-side, 0043).
    if (q.client_id && input.channel !== "internal_note" && input.body) {
      const { error: msgErr } = await ctx.supabase.from("messages").insert({
        client_id: q.client_id,
        channel: input.channel,
        direction: "outbound",
        recipient: input.recipient || q.client_email,
        subject: input.subject || null,
        body: input.body,
        status: "handed_off",
        related_entity_type: "quotation",
        related_entity_id: q.id,
        sent_by: ctx.user.id,
        sent_at: new Date().toISOString(),
      });
      throwIfDbError(msgErr);
    }

    await ctx.audit({
      event: "data_update",
      resourceType: "quotation",
      resourceId: q.id,
      action: input.followUpDay ? "quotations.follow_up_handoff" : "quotations.handoff",
      details: { quotation_number: q.quotation_number, channel: input.channel, recipient: input.recipient || null, follow_up_day: input.followUpDay },
    });
    const what = input.followUpDay
      ? `Day-${input.followUpDay} follow-up on quotation ${q.quotation_number} handed off to ${channelLabel}`
      : input.channel === "internal_note"
        ? `Link to quotation ${q.quotation_number} copied to share`
        : `Quotation ${q.quotation_number} handed off to ${channelLabel}`;
    if (q.lead_id || q.client_id) {
      ctx.after("Add to the timeline", () =>
        addTimelineEvent({
          leadId: q.lead_id,
          clientId: q.client_id,
          eventType: input.followUpDay ? "quotation_follow_up" : "quotation_sent",
          title: what,
          metadata: { quotation_id: q.id, channel: input.channel },
        }),
      );
    }
    ctx.after("Record the quotation's history", () =>
      logActivity({ entityType: "quotation", entityId: q.id, action: input.followUpDay ? "quotation_follow_up" : "quotation_sent", description: `${what} by ${ctx.user.fullName}` }),
    );
    if (input.channel !== "internal_note") {
      ctx.after("Add to your activity", () =>
        logEmployeeActivity({
          activityType: input.channel === "whatsapp_handoff" ? "whatsapp_sent" : "email_sent",
          description: what,
          entityType: "quotation",
          entityId: q.id,
          entityName: q.quotation_number,
        }),
      );
    }
    return ok({ updatedAt, status });
  },
);

export const sendQuotationFollowUp = defineAction(
  { name: "quotations.follow_up_email", schema: FollowUpEmailSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ outcome: EmailSendOutcome }>> => {
    const q = await load(ctx.supabase, input.id);
    if (!["sent", "viewed"].includes(q.status) || q.valid_until < todayIST()) {
      throw new ActionError("This quotation is no longer open, so there is nothing to follow up.");
    }
    const { data: fu, error: fuErr } = await ctx.supabase.from("quotation_follow_ups").select("id, status").eq("quotation_id", q.id).eq("follow_up_day", input.day).maybeSingle();
    throwIfDbError(fuErr);
    if (!fu) return fail(`There is no day-${input.day} follow-up for this quotation.`, { code: "not_found" });
    if (fu.status !== "pending" && fu.status !== "failed") return fail(`The day-${input.day} follow-up has already been ${fu.status}.`, { code: "conflict" });

    const firm = emailFirm(await getFirmProfile(ctx.supabase));
    const mail = quotationFollowUpEmail(
      {
        day: followUpTone(input.day),
        recipientName: q.client_name,
        quotationNumber: q.quotation_number,
        totalPaise: toPaise(q.total),
        validUntil: q.valid_until,
        viewUrl: `${appUrl()}/q/${q.token}`,
        sentOn: q.sent_at ?? todayIST(),
        senderName: ctx.user.fullName,
      },
      firm,
    );
    const sent = await sendEmail({
      to: q.client_email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "quotation_follow_up",
      clientId: q.client_id,
      related: { type: "quotation", id: q.id },
      idempotencyKey: `quotation:${q.id}:follow_up_${input.day}`,
    });
    if (sent.status === "not_configured") return ok({ outcome: { status: "not_configured", error: sent.error } });
    const { error } = await ctx.supabase.rpc("record_quotation_follow_up", {
      p_id: q.id,
      p_day: input.day,
      p_channel: "email",
      p_to: q.client_email,
      p_subject: mail.subject,
      p_status: sent.status === "sent" ? "sent" : "failed",
      p_provider_message_id: sent.providerMessageId ?? null,
      p_error: sent.status === "failed" ? (sent.error ?? "The email didn't go through.") : null,
    });
    throwDb(error);
    await ctx.audit({
      event: "data_update",
      resourceType: "quotation",
      resourceId: q.id,
      action: "quotations.follow_up_email",
      success: sent.status === "sent",
      error: sent.status === "failed" ? (sent.error ?? "The email didn't go through.") : undefined,
      details: { quotation_number: q.quotation_number, day: input.day },
    });
    if (sent.status === "sent") {
      ctx.after("Record the quotation's history", () =>
        logActivity({ entityType: "quotation", entityId: q.id, action: "quotation_follow_up", description: `Day-${input.day} follow-up emailed by ${ctx.user.fullName}` }),
      );
    }
    return ok({ outcome: { status: sent.status, error: sent.error } });
  },
);

// =================================================================================================
// Revise and delete (§7.5.3, §0.1 rule 11)
// =================================================================================================

export const reviseQuotation = defineAction(
  { name: "quotations.revise", schema: QuotationRefSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; quotationNumber: string }>> => {
    const q = await load(ctx.supabase, input.id);
    const { data, error } = await ctx.supabase.rpc("revise_quotation", { p_id: input.id, p_expected_updated_at: input.updatedAt });
    throwDb(error);
    const row = (data ?? [])[0];
    if (!row?.id || !row.quotation_number) throw new Error("revise_quotation returned nothing");
    await ctx.audit({
      event: "data_create",
      resourceType: "quotation",
      resourceId: row.id,
      action: "quotations.revise",
      details: { revises: q.quotation_number, revises_id: q.id, quotation_number: row.quotation_number, revision_number: row.revision_number },
    });
    if (q.lead_id || q.client_id) {
      ctx.after("Add to the timeline", () =>
        addTimelineEvent({
          leadId: q.lead_id,
          clientId: q.client_id,
          eventType: "quotation_revised",
          title: `Quotation ${q.quotation_number} revised as ${row.quotation_number}`,
          metadata: { quotation_id: row.id, revises_id: q.id },
        }),
      );
    }
    ctx.after("Record the quotations' history", async () => {
      await logActivity({ entityType: "quotation", entityId: q.id, action: "quotation_superseded", description: `Replaced by revision ${row.quotation_number} (${ctx.user.fullName}); its link no longer takes responses` });
      await logActivity({ entityType: "quotation", entityId: row.id!, action: "quotation_created", description: `Revision ${row.revision_number} of ${q.quotation_number}, started by ${ctx.user.fullName}` });
    });
    return ok({ id: row.id, quotationNumber: row.quotation_number });
  },
);

export const deleteQuotation = defineAction(
  { name: "quotations.delete", schema: QuotationRefSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const q = await load(ctx.supabase, input.id);
    if (q.status === "accepted") return fail("An accepted quotation is the record of what the client agreed, so it can't be deleted.", { code: "blocked" });
    const { data, error } = await ctx.supabase
      .from("quotations")
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.user.id })
      .eq("id", q.id)
      .eq("updated_at", input.updatedAt)
      .select("id")
      .maybeSingle();
    throwDb(error);
    if (!data) throw stale(q.updated_at);
    await ctx.audit({ event: "data_delete", resourceType: "quotation", resourceId: q.id, action: "quotations.delete", details: { quotation_number: q.quotation_number, status: q.status } });
    if (q.lead_id || q.client_id) {
      ctx.after("Add to the timeline", () =>
        addTimelineEvent({ leadId: q.lead_id, clientId: q.client_id, eventType: "quotation_deleted", title: `Quotation ${q.quotation_number} moved to the recycle bin`, metadata: { quotation_id: q.id } }),
      );
    }
    ctx.after("Record the quotation's history", () =>
      logActivity({ entityType: "quotation", entityId: q.id, action: "quotation_deleted", description: `Moved to the recycle bin by ${ctx.user.fullName}` }),
    );
    return ok({ id: q.id });
  },
);

// =================================================================================================
// Export (§3.4 "CSV export of the current view"; §12 every export audited)
// =================================================================================================

const EXPORT_MAX = 5000;

export type QuotationExport = { fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean };

export const exportQuotations = defineAction(
  { name: "quotations.export", schema: z.object({ query: z.string().max(2000).default("") }), roles: PM },
  async (input, ctx): Promise<ActionResult<QuotationExport>> => {
    const t = parseTableParams(new URLSearchParams(input.query), { sortable: QUOTATION_SORTABLE, defaultSort: { sort: "created_at", dir: "desc" }, filters: QUOTATION_FILTERS });
    const { rows, total } = await listQuotations(ctx.supabase, { ...t, from: 0, to: EXPORT_MAX - 1 }, { userId: ctx.user.id });
    const header = ["Quotation", "Status", "For", "Company", "Email", "Lead", "Client code", "Issue date", "Valid until", "Total incl. GST (₹)", "Prepared by", "Sent on", "Views", "Last viewed", "Answered on", "Revision", "Replaced by"];
    const body = rows.map((r) => [
      r.quotation_number,
      getStatus("quotation_status", r.display_status).label,
      r.client_name,
      r.client_company ?? "",
      r.client_email,
      r.lead_number ?? "",
      r.client_code ?? "",
      formatDate(r.issue_date),
      formatDate(r.valid_until),
      r.total.toFixed(2),
      r.created_by_name ?? "",
      r.sent_at ? formatDate(r.sent_at) : "",
      r.view_count,
      r.last_viewed_at ? formatDate(r.last_viewed_at) : "",
      r.responded_at ? formatDate(r.responded_at) : "",
      r.revision_number,
      r.superseded_by_number ?? "",
    ]);
    const truncated = total > rows.length;
    await ctx.audit({ event: "export_run", resourceType: "quotations", details: { rows: rows.length, truncated, query: input.query } });
    return ok({
      fileName: `taxwise-quotations-${todayIST()}.csv`,
      mimeType: "text/csv;charset=utf-8",
      base64: Buffer.from(toCsv(header, body), "utf8").toString("base64"),
      rows: rows.length,
      truncated,
    });
  },
);
