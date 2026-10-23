"use server";

/**
 * The client portal's writes (§7.22). Every action is the portal user's own (roles: client) and runs
 * under their session, so RLS and the portal policies decide what they may touch (0034, 0038, 0039,
 * 0175, 0176). Nothing here marks an invoice paid, reaches another client, or opens WhatsApp.
 *
 *   acknowledgePrivacyNotice  /portal/welcome (§6.10, §7.22 first sign-in): a consent_records row with
 *                             the notice version, the purposes, channel 'portal' and the IP. Refused if
 *                             a newer version was published while the page was open.
 *   reportPayment             the Pay dialog's "I've paid": reference + date + optional screenshot →
 *                             submit_portal_payment_claim (0176), one transaction. The screenshot is an
 *                             upload slot reserved with requestUploadSlots (server/actions/documents.ts);
 *                             the file is checked here over its whole length first. Partners, and the
 *                             client's owner when a Partner or Manager, are notified to verify (§9).
 *                             It never marks the invoice paid: only a recorded receipt does.
 *   sendPortalMessage         a message to the firm (§7.22 Messages), with up to five files: each an
 *                             upload slot confirmed into the client's vault (finishUpload), attached to
 *                             the message. The owner and team are told (§9 "Client … sent a message").
 *   markPortalMessagesRead    opening Messages: the firm's messages get read receipts
 *                             (mark_portal_message_read, 0176).
 *
 * Until the current privacy notice is acknowledged, every action but the acknowledgement refuses
 * (§7.22 "before anything else").
 */

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { checkRateLimit } from "@/lib/rate-limit";
import { formatDate } from "@/lib/format";
import { getNoticeState, getPortalClient, type PortalClient } from "@/lib/data/portal";
import {
  AcknowledgeNoticeSchema,
  CONSENT_CHANNEL,
  CONSENT_PURPOSE_KEYS,
  MarkReadSchema,
  PaymentClaimSchema,
  PortalMessageSchema,
} from "@/lib/schemas/portal";
import { createAdminClient } from "@/server/admin";
import { finishUpload, inspectStoredFile, removeStoredObjects } from "@/server/files";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { log } from "@/lib/log";

const CLIENT = ["client"] as const;

/** §13-style limits for what a portal user can send. */
const LIMITS = {
  claims: { limit: 10, windowSeconds: 60 * 60 },
  messages: { limit: 30, windowSeconds: 60 * 60 },
} as const;

async function clientFileOf(ctx: ActionContext): Promise<PortalClient> {
  const client = await getPortalClient(ctx.supabase);
  if (!client) {
    throw new ActionError("Your login isn't linked to a client file yet. Ask the firm to check your portal access.", { code: "forbidden" });
  }
  return client;
}

/** §7.22: the privacy notice is acknowledged before anything else. */
async function requireAcknowledged(ctx: ActionContext): Promise<void> {
  const state = await getNoticeState(ctx.supabase, ctx.user.id);
  if (state.required) {
    throw new ActionError("Read and acknowledge the privacy notice first. It opens when you reload the portal.", { code: "forbidden" });
  }
}

async function within(ctx: ActionContext, scope: string, limit: { limit: number; windowSeconds: number }, message: string): Promise<void> {
  const r = await checkRateLimit({
    scope,
    identity: [ctx.user.id],
    ...limit,
    audit: { userId: ctx.user.id, email: ctx.user.email, ip: ctx.ip, userAgent: ctx.userAgent },
  });
  if (!r.allowed) throw new ActionError(message, { code: "rate_limited" });
}

/**
 * The firm's people for a client (§9), looked up by the system after the caller's own RLS-checked
 * write: a portal user can't read the team. `moneyOnly` keeps to the owner when a Partner or Manager
 * (Employees never get money notices, §4.1; insert_notifications drops them too).
 */
async function clientPeople(clientId: string, opts: { moneyOnly: boolean }): Promise<string[]> {
  const admin = createAdminClient();
  const [client, team] = await Promise.all([
    admin.from("clients").select("owner_employee_id").eq("id", clientId).maybeSingle(),
    opts.moneyOnly ? Promise.resolve({ data: [] as Array<{ employee_id: string }>, error: null }) : admin.from("client_team_members").select("employee_id").eq("client_id", clientId),
  ]);
  if (client.error) throw client.error;
  if (team.error) throw team.error;
  const ids = [client.data?.owner_employee_id, ...(team.data ?? []).map((t) => t.employee_id)].filter((v): v is string => !!v);
  if (!opts.moneyOnly || ids.length === 0) return [...new Set(ids)];
  // The role is profiles.role (§0.1 rule 9), not the employee row's copy.
  const { data: staff, error } = await admin.from("employees").select("id, profile_id, is_active, deleted_at").in("id", ids);
  if (error) throw error;
  const live = (staff ?? []).filter((e) => e.is_active && !e.deleted_at && e.profile_id);
  if (live.length === 0) return [];
  const { data: profiles, error: pError } = await admin
    .from("profiles")
    .select("id, role, is_active")
    .in(
      "id",
      live.map((e) => e.profile_id as string),
    );
  if (pError) throw pError;
  const managers = new Set((profiles ?? []).filter((p) => p.is_active && (p.role === "partner" || p.role === "manager")).map((p) => p.id));
  return live.filter((e) => managers.has(e.profile_id as string)).map((e) => e.id);
}

// -------------------------------------------------------------------------------------------------
// The privacy notice (§6.10, §7.22)
// -------------------------------------------------------------------------------------------------

export const acknowledgePrivacyNotice = defineAction(
  { name: "portal.acknowledge_notice", schema: AcknowledgeNoticeSchema, roles: CLIENT },
  async (input, ctx): Promise<ActionResult<{ version: string; acknowledgedAt: string; already: boolean }>> => {
    const state = await getNoticeState(ctx.supabase, ctx.user.id);
    if (!state.notice) return fail("There's no privacy notice to acknowledge right now. Go to your portal.", { code: "blocked" });
    if (state.notice.version !== input.noticeVersion) {
      return fail("The privacy notice was updated while you were reading it. Read the new version below and acknowledge it.", { code: "conflict" });
    }
    if (state.acknowledgedAt) return ok({ version: state.notice.version, acknowledgedAt: state.acknowledgedAt, already: true });

    const { data, error } = await ctx.supabase
      .from("consent_records")
      .insert({
        subject_type: "portal_user",
        subject_id: ctx.user.id,
        notice_version: state.notice.version,
        purposes: CONSENT_PURPOSE_KEYS,
        channel: CONSENT_CHANNEL,
        ip: ctx.ip,
      })
      .select("id, given_at")
      .single();
    throwIfDbError(error);
    const row = data as { id: string; given_at: string };

    await ctx.audit({
      event: "data_create",
      resourceType: "consent_record",
      resourceId: row.id,
      details: { subject_type: "portal_user", notice_version: state.notice.version, purposes: CONSENT_PURPOSE_KEYS, channel: CONSENT_CHANNEL },
    });

    const version = state.notice.version;
    ctx.after("Note the acknowledgement on the client's timeline", async () => {
      const client = await getPortalClient(ctx.supabase);
      if (!client) return;
      await addTimelineEvent({
        clientId: client.id,
        eventType: "privacy_notice_acknowledged",
        title: `Privacy notice ${version} acknowledged in the portal`,
        metadata: { notice_version: version, consent_record_id: row.id },
      });
    });
    return ok({ version, acknowledgedAt: row.given_at, already: false });
  },
);

// -------------------------------------------------------------------------------------------------
// "I've paid" (§7.22 Pay dialog, §18.3 Client 4)
// -------------------------------------------------------------------------------------------------

type ClaimResult = { claimId: string; invoiceNumber: string; hasScreenshot: boolean };

type SlotRow = {
  id: string;
  client_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  purpose: string;
  confirmed_at: string | null;
  failed_at: string | null;
  failure: string | null;
};

export const reportPayment = defineAction(
  { name: "portal.report_payment", schema: PaymentClaimSchema, roles: CLIENT },
  async (input, ctx): Promise<ActionResult<ClaimResult>> => {
    await requireAcknowledged(ctx);
    const client = await clientFileOf(ctx);
    await within(ctx, "portal_payment_claim", LIMITS.claims, "You've reported several payments in the last hour. Please try again later, or send us a message.");

    // The screenshot: the caller's own slot, checked over its whole length before it becomes a document.
    let file: { size: number; mimeType: string; sha256: string } | null = null;
    if (input.uploadId) {
      const { data, error } = await ctx.supabase
        .from("document_uploads")
        .select("id, client_id, storage_path, file_name, mime_type, purpose, confirmed_at, failed_at, failure")
        .eq("id", input.uploadId)
        .eq("created_by", ctx.user.id)
        .maybeSingle();
      throwIfDbError(error);
      const slot = data as SlotRow | null;
      const fieldError = (m: string) => new ActionError(m, { code: "validation", fieldErrors: { uploadId: [m] } });
      if (!slot || slot.client_id !== client.id) throw fieldError("The screenshot upload wasn't found. Attach it again.");
      if (slot.failed_at) throw fieldError(`The screenshot was refused: ${slot.failure ?? "it didn't pass the checks."} Attach another.`);
      if (slot.confirmed_at || slot.purpose !== "new_document") throw fieldError("That screenshot is already attached to something else. Attach it again.");
      const inspected = await inspectStoredFile(slot.storage_path, { declaredMime: slot.mime_type, fileName: slot.file_name });
      if (!inspected.ok) {
        await ctx.supabase.rpc("discard_document_upload", { p_upload_id: slot.id, p_reason: inspected.reason });
        if (!inspected.missing) await removeStoredObjects([slot.storage_path]);
        throw fieldError(inspected.reason);
      }
      file = { size: inspected.size, mimeType: inspected.mimeType, sha256: inspected.sha256 };
    }

    const { data, error } = await ctx.supabase.rpc("submit_portal_payment_claim", {
      p_invoice_id: input.invoiceId,
      p_reference: input.reference,
      p_paid_on: input.paidOn,
      p_note: input.note,
      p_upload_id: input.uploadId,
      p_file_size: file?.size ?? null,
      p_mime_type: file?.mimeType ?? null,
      p_sha256: file?.sha256 ?? null,
    });
    throwIfDbError(error);
    const r = (data ?? {}) as { claim_id?: string; invoice_number?: string; client_id?: string; document_id?: string | null };
    if (!r.claim_id) throw new Error("submit_portal_payment_claim returned no claim id");
    const claimId = r.claim_id;
    const invoiceNumber = r.invoice_number ?? "";
    const documentId = r.document_id ?? null;

    await ctx.audit({
      event: "data_create",
      resourceType: "portal_payment_claim",
      resourceId: claimId,
      details: { invoice_id: input.invoiceId, invoice_number: invoiceNumber, paid_on: input.paidOn, screenshot_document_id: documentId },
    });
    if (documentId && file) {
      await ctx.audit({
        event: "file_upload",
        resourceType: "document",
        resourceId: documentId,
        action: "portal.payment_proof",
        details: { client_id: client.id, purpose: "payment_proof", file_size: file.size, mime_type: file.mimeType, source: "client_portal" },
      });
    }

    const reference = input.reference;
    const paidOn = input.paidOn;
    ctx.after(
      "Tell the firm about the payment",
      async () => {
        const owners = await clientPeople(client.id, { moneyOnly: true });
        await notify({
          to: { roles: ["partner"], employeeIds: owners },
          type: "payment_received",
          title: `${client.displayName} says they've paid ${invoiceNumber}`,
          body: `Reference ${reference}, paid on ${formatDate(paidOn)}${documentId ? ", with a screenshot" : ""}. Check the bank account and record the receipt; the invoice stays unpaid until you do.`,
          linkUrl: `/invoices/${input.invoiceId}`,
          entity: { type: "invoice", id: input.invoiceId },
          clientId: client.id,
          dedupeKey: `portal_payment_claim:${claimId}`,
        });
      },
      "Your payment report is saved, but the firm wasn't alerted. Send them a message to say you've paid.",
    );
    ctx.after("Note the payment report on the client's timeline", async () => {
      // A money-side event (§4.1): Employees never see it, and a portal user can't write one, so the
      // system writes it after the RLS-checked claim above.
      const { error: tlError } = await createAdminClient()
        .from("client_timeline_events")
        .insert({
          client_id: client.id,
          event_type: "portal_payment_claim_reported",
          title: `Client reported a payment for ${invoiceNumber} (ref ${reference.slice(0, 60)})`,
          metadata: { claim_id: claimId, invoice_id: input.invoiceId, paid_on: paidOn, screenshot_document_id: documentId },
          performed_by: ctx.user.id,
        });
      if (tlError) throw tlError;
    });

    return ok({ claimId, invoiceNumber, hasScreenshot: Boolean(documentId) });
  },
);

// -------------------------------------------------------------------------------------------------
// Messages (§7.22)
// -------------------------------------------------------------------------------------------------

export const sendPortalMessage = defineAction(
  { name: "portal.send_message", schema: PortalMessageSchema, roles: CLIENT },
  async (input, ctx): Promise<ActionResult<{ id: string; attachments: number }>> => {
    await requireAcknowledged(ctx);
    const client = await clientFileOf(ctx);
    await within(ctx, "portal_message", LIMITS.messages, "You've sent a lot of messages in the last hour. Please try again a little later.");

    // Attachments first: the caller's own new-file slots for this client, each then checked over its
    // whole length and filed in the client's vault.
    if (input.uploadIds.length > 0) {
      const { data: slots, error: slotError } = await ctx.supabase
        .from("document_uploads")
        .select("id, client_id, purpose")
        .in("id", input.uploadIds)
        .eq("created_by", ctx.user.id);
      throwIfDbError(slotError);
      const ok = new Set((slots ?? []).filter((s) => s.client_id === client.id && s.purpose === "new_document").map((s) => s.id));
      if (input.uploadIds.some((id) => !ok.has(id))) {
        throw new ActionError("An attachment wasn't found. Attach it again.", { code: "validation" });
      }
    }
    const documentIds: string[] = [];
    for (const uploadId of input.uploadIds) {
      const done = await finishUpload(ctx, uploadId);
      if (done.clientId !== client.id || done.purpose !== "new_document") {
        throw new ActionError("An attachment doesn't belong to this message. Attach it again.", { code: "validation" });
      }
      if (!documentIds.includes(done.documentId)) documentIds.push(done.documentId);
    }

    const now = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: client.id,
        channel: "portal",
        direction: "inbound",
        body: input.body,
        status: "sent",
        sent_by: ctx.user.id,
        sent_at: now,
      })
      .select("id")
      .single();
    throwIfDbError(error);
    const id = (data as { id: string }).id;

    if (documentIds.length > 0) {
      const { error: attError } = await ctx.supabase.from("message_attachments").insert(documentIds.map((document_id) => ({ message_id: id, document_id })));
      throwIfDbError(attError);
    }

    await ctx.audit({
      event: "data_create",
      resourceType: "message",
      resourceId: id,
      details: { channel: "portal", direction: "inbound", client_id: client.id, attachments: documentIds.length },
    });

    const preview = input.body.replace(/\s+/g, " ").trim();
    ctx.after(
      "Tell the client's team",
      async () => {
        const people = await clientPeople(client.id, { moneyOnly: false });
        await notify({
          to: people.length ? { employeeIds: people } : { roles: ["partner", "manager"] },
          // §9 "Client uploaded a document / sent a message" → the thread. The entity is the client's
          // conversation (inbox_action_items 'client_messages', 0172), so the Inbox shows it as that
          // item's new dot instead of a second row in Updates.
          type: "document_uploaded",
          title: `${client.displayName} sent a message`,
          body: `${preview.length > 160 ? `${preview.slice(0, 159)}…` : preview}${documentIds.length ? ` (${documentIds.length} ${documentIds.length === 1 ? "file" : "files"} attached)` : ""}`,
          linkUrl: `/messages?client=${client.id}`,
          entity: { type: "client_messages", id: client.id },
          clientId: client.id,
          dedupeKey: `portal_message:${id}`,
        });
      },
      "Your message is with the firm, but they weren't alerted. It will show in their inbox.",
    );
    ctx.after("Add the message to the client's timeline", () =>
      addTimelineEvent({
        clientId: client.id,
        eventType: "message_received",
        title: documentIds.length ? `Portal message from the client, with ${documentIds.length} ${documentIds.length === 1 ? "file" : "files"}` : "Portal message from the client",
        metadata: { channel: "portal", message_id: id, attachments: documentIds.length },
      }),
    );
    return ok({ id, attachments: documentIds.length });
  },
);

export const markPortalMessagesRead = defineAction(
  { name: "portal.mark_read", schema: MarkReadSchema, roles: CLIENT },
  async (input, ctx): Promise<ActionResult<{ marked: number }>> => {
    await requireAcknowledged(ctx);
    const { data, error } = await ctx.supabase.rpc("mark_portal_message_read", { p_message_ids: input.messageIds });
    throwIfDbError(error);
    const marked = typeof data === "number" ? data : 0;
    if (marked > 0) {
      await ctx.audit({ event: "data_update", resourceType: "message_thread", action: "portal.mark_read", details: { marked } });
    } else if (data === null) {
      log("warn", "mark_portal_message_read returned nothing", { source: "action:portal.mark_read", userId: ctx.user.id });
    }
    return ok({ marked });
  },
);
