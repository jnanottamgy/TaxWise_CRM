"use server";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult, type FieldErrors } from "@/lib/result";
import { STAFF_ROLES, isManagerOrPartner } from "@/lib/auth/roles";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { formatDate, formatMoney } from "@/lib/format";
import { addDays, istDateOf, todayIST } from "@/lib/domain/fy";
import { duplicateBlocks, describeDuplicate, type DuplicateCandidate, type DuplicateMatch } from "@/lib/domain/conflict";
import { parseTableParams } from "@/components/app/data-table/params";
import {
  BulkGroupSchema,
  BulkOwnerSchema,
  BulkStatusSchema,
  CLIENT_LIST_FILTERS,
  CLIENT_LIST_SORTABLE,
  ClientStatusChangeSchema,
  DeleteClientSchema,
  DeleteClientViewSchema,
  ExportClientsSchema,
  FinishAttachmentSchema,
  PrepareAttachmentSchema,
  SaveClientViewSchema,
  checkAttachment,
  clientExportTable,
  sniffAttachment,
  toCsv,
} from "@/lib/schemas/clients";
import {
  CalendarInputsSchema,
  OnboardingInputSchema,
  QUOTATION_SERVICES_LOCK,
  allIssues,
  gstFrequencyLock,
  schemeDecisionFor,
  serviceName,
  type PreviewEvent,
} from "@/lib/schemas/onboarding";
import {
  getClientsBrief,
  getQuotationForOnboarding,
  getUnpaidInvoices,
  listClientsForExport,
  loadScaleParameterRows,
  scaleContextFrom,
  suggestClientCode,
} from "@/lib/data/clients";
import { buildOnboardPayload, generateOnboardingEvents, loadCalendarEngine, nextDueByService, servicesInWords, toPreviewEvent } from "@/server/onboarding";
import { inviteClientToPortal, type PortalInviteResult } from "@/server/portal-invite";
import { generateDeadlinesForClient } from "@/server/actions/compliance";
import { getMyCoveredClients } from "@/lib/data/covers";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";
import { sendEmail } from "@/server/email/send";
import { emailFirm } from "@/server/email/templates/layout";
import { welcomeEmail } from "@/server/email/templates/welcome";
import { getFirmProfile } from "@/server/firm";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { ClientStatus } from "@/lib/domain/enums";

/**
 * Client mutations (§7.3): the onboarding wizard's checks and Complete (§7.3.2), checklist
 * attachments, status changes with a reason, delete to the recycle bin, bulk actions, export and
 * saved views (§7.3.1, §7.3.4). Every action goes through defineAction (role from profiles.role,
 * zod, audit, after-effects as warnings) and writes under the caller's session, so RLS agrees.
 *
 * Shared with Client 360 (§7.3.3, §7.3.4): changeClientStatus({ clientId, to, reason, updatedAt })
 * and deleteClient({ clientId, updatedAt }).
 */

const PM = ["partner", "manager"] as const;

const STATUS_LABEL: Record<ClientStatus, string> = { active: "Active", pending: "Pending", on_hold: "On hold", inactive: "Inactive" };

function issuesToFieldErrors(issues: ReadonlyArray<{ path: string; message: string }>): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) (out[i.path] ??= []).push(i.message);
  return out;
}

// =================================================================================================
// Duplicate guard and client code (§7.3.2 step 1)
// =================================================================================================

const DuplicateCheckSchema = z.object({
  pan: z.string().trim().max(10).default(""),
  gstin: z.string().trim().max(15).default(""),
  name: z.string().trim().max(200).default(""),
  excludeClientId: z.uuid().nullish(),
});

async function findDuplicates(supabase: ServerSupabase, input: { pan: string; gstin: string; name: string; excludeClientId?: string | null }): Promise<DuplicateCandidate[]> {
  if (!input.pan && !input.gstin && input.name.length < 3) return [];
  const { data, error } = await supabase.rpc("find_client_duplicates", {
    p_pan: input.pan || null,
    p_gstin: input.gstin || null,
    p_name: input.name.length >= 3 ? input.name : null,
    p_exclude_client: input.excludeClientId ?? null,
  });
  if (error) throw error;
  return (data ?? [])
    .filter((d) => d.client_id && d.matched_on)
    .map((d) => ({
      clientId: d.client_id as string,
      clientCode: d.client_code ?? "",
      displayName: d.display_name ?? "",
      inRecycleBin: Boolean(d.in_recycle_bin),
      matchedOn: d.matched_on as DuplicateMatch,
      score: Number(d.score ?? 0),
    }));
}

/** "This looks like X (TW-C-0042)": clients (the recycle bin too) with the same PAN or GSTIN, or a close name (§7.3.2). */
export const checkClientDuplicates = defineAction(
  { name: "clients.duplicates", schema: DuplicateCheckSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ duplicates: DuplicateCandidate[] }>> => {
    return ok({ duplicates: await findDuplicates(ctx.supabase, input) });
  },
);

/** Whether a client code is free (§5.3 "unique"). */
export const checkClientCode = defineAction(
  { name: "clients.code_available", schema: z.object({ code: z.string().trim().min(1).max(20) }), roles: PM },
  async (input, ctx): Promise<ActionResult<{ available: boolean }>> => {
    const { count, error } = await ctx.supabase.from("clients").select("id", { count: "exact", head: true }).eq("client_code", input.code.toUpperCase());
    throwIfDbError(error);
    return ok({ available: (count ?? 0) === 0 });
  },
);

/** The next free client code, for "Add another client" after a completed onboarding. */
export const suggestNextClientCode = defineAction(
  { name: "clients.code_suggest", schema: z.object({}), roles: PM },
  async (_input, ctx): Promise<ActionResult<{ code: string }>> => ok({ code: await suggestClientCode(ctx.supabase) }),
);

// =================================================================================================
// The deadline preview (§7.3.2 steps 3 and 5)
// =================================================================================================

export type DeadlinePreview = {
  events: PreviewEvent[];
  /** Next statutory due date per service, for step 3. */
  nextDue: Record<string, string>;
  generatedFor: string;
};

/** The deadlines the statutory engine will create for this client (§6.7), from the law tables. */
export const previewOnboardingDeadlines = defineAction(
  { name: "clients.onboarding_preview", schema: CalendarInputsSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<DeadlinePreview>> => {
    const today = todayIST();
    const engine = await loadCalendarEngine(ctx.supabase, today);
    const events = generateOnboardingEvents(engine, input, randomUUID(), today);
    return ok({ events: events.map(toPreviewEvent), nextDue: nextDueByService(events) as Record<string, string>, generatedFor: today });
  },
);

// =================================================================================================
// Complete onboarding (§7.3.2)
// =================================================================================================

export type OnboardingResult = {
  clientId: string;
  clientCode: string;
  displayName: string;
  taskCount: number;
  eventCount: number;
  /** The checklist rows created, in order (to attach the files picked in step 4). */
  checklist: Array<{ id: string; label: string }>;
  /** Filled by the after-effects (§0.1 rule 5): the portal login handout, shown once. */
  portal: PortalInviteResult | null;
  welcome: { status: "sent" | "not_configured" | "failed" | "skipped"; to: string | null; error?: string } | null;
  whatsappTaskId: string | null;
};

export const completeOnboarding = defineAction(
  { name: "clients.onboard", schema: OnboardingInputSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<OnboardingResult>> => {
    const today = todayIST();
    const isPartner = ctx.user.role === "partner";

    // Every step's rules again (the browser's checks are a convenience, §0.1 rule 8).
    const issues = allIssues(input, today);
    if (!isPartner && input.tax_audit_decision !== "review") {
      issues.push({ path: "tax_audit_decision", message: "Only a Partner can confirm whether a tax audit applies. Leave it as Partner to review." });
    }
    if (issues.length) return fail("Please check the highlighted fields.", { code: "validation", fieldErrors: issuesToFieldErrors(issues) });

    // Duplicate guard: PAN / GSTIN can't repeat; a close name needs a reason (§7.3.2).
    const dups = await findDuplicates(ctx.supabase, { pan: input.pan, gstin: input.gstin, name: input.display_name });
    const blocking = dups.find(duplicateBlocks);
    if (blocking) {
      const d = describeDuplicate(blocking);
      const field = blocking.matchedOn === "gstin" ? "gstin" : input.pan ? "pan" : "gstin";
      return fail(`${d.headline}. ${d.detail}`, { code: "conflict", fieldErrors: { [field]: [`${d.headline}. ${d.detail}`] } });
    }
    if (dups.length > 0 && !input.duplicate_reason.trim()) {
      const d = describeDuplicate(dups[0]);
      return fail(`${d.headline}. Give a reason to continue anyway.`, {
        code: "validation",
        fieldErrors: { duplicate_reason: ["Say why this is a different client from the one it looks like."] },
      });
    }

    // From a quotation: the services are the ones the client accepted (§7.3.2).
    if (input.source_quotation_id) {
      const q = await getQuotationForOnboarding(ctx.supabase, input.source_quotation_id);
      if (!q) return fail("The quotation wasn't found.", { code: "not_found" });
      const itemIds = new Set(q.items.map((i) => i.id));
      if (input.services.some((s) => !s.source_quotation_item_id || !itemIds.has(s.source_quotation_item_id))) {
        return fail(QUOTATION_SERVICES_LOCK, { code: "validation", fieldErrors: { services: [QUOTATION_SERVICES_LOCK] } });
      }
    }

    // §7.3.2 / §6.8: audit work needs a conflict check with the decision Accept.
    const needsAcceptance = input.services.some((s) => s.service_type === "audit");
    if (input.acceptance_id || needsAcceptance) {
      const { data: acc, error: accErr } = input.acceptance_id
        ? await ctx.supabase.from("client_acceptances").select("id, outcome, client_id").eq("id", input.acceptance_id).maybeSingle()
        : { data: null, error: null };
      throwIfDbError(accErr);
      if (input.acceptance_id && (!acc || acc.client_id)) {
        return fail("The conflict check wasn't found or belongs to another client. Run it again.", { code: "validation", fieldErrors: { acceptance_id: ["Run the conflict check again."] } });
      }
      if (acc?.outcome === "declined") {
        return fail("The acceptance decision for this client is Decline, so it can't be onboarded.", { code: "blocked", fieldErrors: { acceptance_id: ["The decision was Decline."] } });
      }
      if (needsAcceptance && acc?.outcome !== "accepted") {
        const message = "Audit work needs the conflict check with the decision Accept. Run it in step 1.";
        return fail(message, { code: "validation", fieldErrors: { acceptance_id: [message] } });
      }
    }

    // A code typed by hand must be free.
    if (!input.client_code_auto) {
      const { count, error } = await ctx.supabase.from("clients").select("id", { count: "exact", head: true }).eq("client_code", input.client_code);
      throwIfDbError(error);
      if (count) return fail(`Client code ${input.client_code} is already in use.`, { code: "conflict", fieldErrors: { client_code: ["This code is already in use. Choose another."] } });
    }

    // The deadlines (§6.7). If the engine can't run, the client is still created, with a warning (§0.1 rule 5).
    const clientId = randomUUID();
    const warnings: string[] = [];
    let events: ReturnType<typeof generateOnboardingEvents> = [];
    const scale = scaleContextFrom(await loadScaleParameterRows(ctx.supabase), today);
    // GST follows the scheme (§7.3.2 step 3), so the welcome email and the payload agree.
    const gstFrequency = gstFrequencyLock(schemeDecisionFor(input, scale)).frequency;
    for (const s of input.services) if (s.service_type === "gst") s.frequency = gstFrequency;
    try {
      const engine = await loadCalendarEngine(ctx.supabase, today);
      events = generateOnboardingEvents(engine, input, clientId, today);
    } catch (err) {
      log("error", "deadline generation failed during onboarding", { source: "action:clients.onboard", userId: ctx.user.id, err });
      warnings.push("Client created. Compliance dates couldn't be generated. Use 'Generate deadlines' on the Compliance tab.");
    }

    const payload = buildOnboardPayload(input, {
      clientId,
      events,
      today,
      scale,
      isPartner,
      acceptanceId: input.acceptance_id || null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    const { data, error } = await ctx.supabase.rpc("onboard_client", { p_payload: payload });
    if (error) {
      const msg = error.message ?? "";
      if (msg.startsWith("USER: Client code")) throw new ActionError(msg.slice(6), { code: "conflict", fieldErrors: { client_code: [msg.slice(6)] } });
      if (msg.startsWith("USER: Audit work needs") || msg.includes("acceptance decision")) throw new ActionError(msg.slice(6), { fieldErrors: { acceptance_id: [msg.slice(6)] } });
      throwIfDbError(error, { uniqueMessage: "A client with this PAN or GSTIN already exists. Search for it before adding it again." });
    }
    const res = data as {
      client_id: string;
      client_code: string;
      display_name: string;
      task_ids: string[];
      checklist: Array<{ id: string; label: string; sort_order: number }>;
      event_count: number;
    };

    const result: OnboardingResult = {
      clientId: res.client_id,
      clientCode: res.client_code,
      displayName: res.display_name,
      taskCount: res.task_ids.length,
      eventCount: res.event_count,
      checklist: [...res.checklist].sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ id: c.id, label: c.label })),
      portal: null,
      welcome: null,
      whatsappTaskId: null,
    };
    const link = `/clients/${res.client_id}`;
    const ownerId = input.owner_employee_id;
    const teamIds = [input.engagement_partner_id, input.review_manager_id, ...input.preparer_ids].filter((x): x is string => !!x && x !== ownerId);
    const firstDue = addDays(today, 14);

    // The transaction planned the statutory deadlines; the compliance engine adds the firm's
    // preparation steps (§7.7) for the same services. Idempotent, so nothing is planned twice.
    if (events.length > 0) {
      ctx.after(
        "Plan the preparation steps",
        async () => {
          const r = await generateDeadlinesForClient({ clientId: res.client_id });
          if (!r.ok) throw new Error(r.error);
          result.eventCount += r.data.created;
        },
        "Client created. The preparation steps for its deadlines couldn't be planned. Use 'Generate deadlines' on the Compliance tab.",
      );
    }

    ctx.after(
      "Tell the owner and the team",
      async () => {
        await notify({
          to: { employeeIds: [ownerId] },
          type: "task_assigned",
          title: `New client: ${res.display_name} (${res.client_code})`,
          body: `You're the owner. ${res.task_ids.length} ${res.task_ids.length === 1 ? "task" : "tasks"} to collect documents ${res.task_ids.length === 1 ? "is" : "are"} waiting for you to accept, due ${formatDate(firstDue)}.`,
          linkUrl: `/work?client=${res.client_id}`,
          entity: { type: "client", id: res.client_id },
          clientId: res.client_id,
        });
        if (teamIds.length) {
          await notify({
            to: { employeeIds: teamIds },
            type: "info",
            title: `You're on the team for ${res.display_name}`,
            body: `${res.display_name} (${res.client_code}) was onboarded with ${input.services.map(serviceName).join(", ")}.`,
            linkUrl: link,
            entity: { type: "client", id: res.client_id },
            clientId: res.client_id,
          });
        }
      },
      "The owner and the team weren't notified. Let them know about the new client.",
    );

    // §7.25.2: "Set up the WhatsApp group" on the engagement partner's to-do list (the owner's when there is none).
    const whatsappAssignee = input.engagement_partner_id || ownerId;
    ctx.after(
      "Add the WhatsApp group to-do",
      async () => {
        const { data: task, error: taskErr } = await ctx.supabase
          .from("tasks")
          .insert({
            client_id: res.client_id,
            title: "Set up the WhatsApp group",
            description:
              "Follow the checklist on the client's WhatsApp group tab: the group name, saving the contacts, adding the firm's numbers, group settings, the Managers' office as admin, the welcome message, then mark the group created.",
            due_date: addDays(today, 2),
            priority: "medium",
            assigned_employee_id: whatsappAssignee,
            created_by: ctx.user.id,
          })
          .select("id")
          .single();
        if (taskErr) throw taskErr;
        result.whatsappTaskId = task.id;
        await notify({
          to: { employeeIds: [whatsappAssignee] },
          type: "task_assigned",
          title: `Set up the WhatsApp group for ${res.display_name}`,
          body: "Follow the checklist on the client's WhatsApp group tab.",
          linkUrl: `${link}?tab=whatsapp`,
          entity: { type: "task", id: task.id },
          clientId: res.client_id,
        });
      },
      "The WhatsApp group to-do wasn't added. Open the client's WhatsApp group tab to set it up.",
    );

    if (input.invite_portal) {
      ctx.after(
        "Invite to the client portal",
        async () => {
          result.portal = await inviteClientToPortal(ctx.supabase, ctx.user, res.client_id, { ip: ctx.ip, userAgent: ctx.userAgent });
        },
        "The portal invite didn't go through. Invite the client from their Overview.",
      );
    }

    if (input.send_welcome && input.email) {
      ctx.after(
        "Send the welcome email",
        async () => {
          const to = input.email.toLowerCase();
          const firm = emailFirm(await getFirmProfile(ctx.supabase));
          const { data: owner } = await ctx.supabase.from("employees").select("full_name, email, phone").eq("id", ownerId).maybeSingle();
          const mail = welcomeEmail(
            {
              contactName: input.contact_name || input.display_name,
              clientName: res.display_name,
              ownerName: owner?.full_name ?? ctx.user.fullName,
              ownerEmail: owner?.email ?? null,
              ownerPhone: owner?.phone ?? null,
              services: servicesInWords(input),
              portalUrl: input.invite_portal ? `${env.appUrl().replace(/\/+$/, "")}/portal` : null,
              senderName: ctx.user.fullName,
            },
            firm,
          );
          const r = await sendEmail({
            to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            kind: "welcome",
            clientId: res.client_id,
            related: { type: "client", id: res.client_id },
            idempotencyKey: `welcome:${res.client_id}`,
          });
          result.welcome = { status: r.status, to, error: r.error };
        },
        "The welcome email wasn't sent. Send it from the client's Communication tab.",
      );
    } else {
      result.welcome = { status: "skipped", to: input.email || null };
    }

    ctx.after("Log the activity", () =>
      logEmployeeActivity({
        activityType: "client_created",
        description: `Onboarded ${res.display_name} (${res.client_code})`,
        entityType: "client",
        entityId: res.client_id,
        entityName: res.display_name,
      }),
    );

    return ok(result, warnings);
  },
);

// =================================================================================================
// Attaching collected documents to checklist items (§7.3.2 step 4)
// =================================================================================================

async function checklistItem(supabase: ServerSupabase, clientId: string, itemId: string) {
  const { data, error } = await supabase.from("client_document_checklist_items").select("id, client_id, label, document_id").eq("id", itemId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.client_id !== clientId) throw new ActionError("That checklist item isn't this client's.", { code: "not_found" });
  return data;
}

/** Step 1 of attaching a file: a signed upload URL for `client-documents/<client_id>/<uuid>.<ext>` (§5.8, §12). */
export const prepareChecklistUpload = defineAction(
  { name: "clients.checklist_upload.prepare", schema: PrepareAttachmentSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ path: string; token: string; contentType: string }>> => {
    const check = checkAttachment({ name: input.fileName, size: input.size });
    if (!check.ok) return fail(check.error, { code: "validation" });
    await checklistItem(ctx.supabase, input.clientId, input.itemId);
    const path = `${input.clientId}/${randomUUID()}.${check.ext}`;
    const { data, error } = await ctx.supabase.storage.from("client-documents").createSignedUploadUrl(path);
    if (error || !data) throw Object.assign(new Error(`client-documents upload URL: ${error?.message ?? "no data"}`), { code: "storage" });
    return ok({ path, token: data.token, contentType: check.mime });
  },
);

/** Step 2: checks the uploaded file's real type, files it in the vault and ticks the checklist item. */
export const finishChecklistUpload = defineAction(
  { name: "clients.checklist_upload.finish", schema: FinishAttachmentSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ documentId: string }>> => {
    const ext = (input.path.split(".").pop() ?? "").toLowerCase();
    const pattern = new RegExp(`^${input.clientId}/[0-9a-f-]{36}\\.${ext}$`);
    if (!pattern.test(input.path)) return fail("The upload's location isn't this client's folder.", { code: "validation" });
    const item = await checklistItem(ctx.supabase, input.clientId, input.itemId);
    const bucket = ctx.supabase.storage.from("client-documents");
    const discard = async () => {
      const { error } = await bucket.remove([input.path]);
      if (error) log("warn", "rejected upload not removed", { source: "action:clients.checklist_upload.finish", path: input.path, err: error });
    };
    const { data: blob, error: dlErr } = await bucket.download(input.path);
    if (dlErr || !blob) return fail("The upload didn't arrive. Try attaching the file again.", { code: "not_found" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = checkAttachment({ name: input.fileName, size: bytes.length });
    if (!size.ok) {
      await discard();
      return fail(size.error, { code: "validation" });
    }
    const sniff = sniffAttachment(bytes, ext);
    if (!sniff.ok) {
      await discard();
      return fail(sniff.error, { code: "validation" });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { data: doc, error: docErr } = await ctx.supabase
      .from("documents")
      .insert({
        client_id: input.clientId,
        title: item.label,
        category: input.category,
        file_name: input.fileName.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 200),
        file_size: bytes.length,
        mime_type: sniff.mime,
        storage_path: input.path,
        sha256,
        source: "staff",
        uploaded_by: ctx.user.id,
      })
      .select("id")
      .single();
    if (docErr) {
      await discard();
      throwIfDbError(docErr);
    }
    const now = new Date().toISOString();
    const { error: itemErr } = await ctx.supabase
      .from("client_document_checklist_items")
      .update({ collected: true, collected_at: now, collected_by: ctx.user.id, document_id: doc!.id })
      .eq("id", input.itemId);
    throwIfDbError(itemErr);
    await ctx.audit({ event: "file_upload", resourceType: "document", resourceId: doc!.id, details: { client_id: input.clientId, checklist_item_id: input.itemId, bytes: bytes.length, mime: sniff.mime } });
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "document_uploaded", title: `Document uploaded: ${item.label}`, metadata: { document_id: doc!.id } }),
    );
    return ok({ documentId: doc!.id });
  },
);

// =================================================================================================
// Status, delete (§7.3.4)
// =================================================================================================

/** Changes a client's status with a reason (§7.3.4). On hold / Inactive pause reminders and auto-invoicing. */
export const changeClientStatus = defineAction(
  { name: "clients.status", schema: ClientStatusChangeSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ updated_at: string; status: ClientStatus }>> => {
    const { data, error } = await ctx.supabase.rpc("change_client_status", {
      p_client_id: input.clientId,
      p_to: input.to,
      p_reason: input.reason,
      p_updated_at: input.updatedAt,
    });
    if (error && (error.message ?? "").startsWith("USER: Changed by")) throw new ActionError(error.message.slice(6), { code: "conflict" });
    throwIfDbError(error);
    const r = data as { updated_at: string; from: ClientStatus; to: ClientStatus; display_name: string };
    await ctx.audit({
      event: "data_update",
      resourceType: "client",
      resourceId: input.clientId,
      details: { field: "status", before: r.from, after: r.to, reason: input.reason },
    });
    ctx.after("Log the activity", () =>
      logEmployeeActivity({
        activityType: "client_updated",
        description: `${r.display_name}: status ${STATUS_LABEL[r.from]} → ${STATUS_LABEL[r.to]}`,
        entityType: "client",
        entityId: input.clientId,
        entityName: r.display_name,
      }),
    );
    return ok({ updated_at: r.updated_at, status: r.to });
  },
);

/** Moves a client to the recycle bin with everything under it; Partner only; blocked while invoices are unpaid (§7.3.4). */
export const deleteClient = defineAction(
  { name: "clients.delete", schema: DeleteClientSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ display_name: string; client_code: string; tasks: number; documents: number }>> => {
    const unpaid = await getUnpaidInvoices(ctx.supabase, input.clientId);
    if (unpaid.count > 0) {
      const [c] = await getClientsBrief(ctx.supabase, [input.clientId]);
      throw new ActionError(
        `${c?.display_name ?? "This client"} has ${unpaid.count} unpaid ${unpaid.count === 1 ? "invoice" : "invoices"} (${formatMoney(unpaid.outstanding)} outstanding). Record the payments or waive ${unpaid.count === 1 ? "it" : "them"} first, then delete the client.`,
      );
    }
    const { data, error } = await ctx.supabase.rpc("delete_client", { p_client_id: input.clientId, p_updated_at: input.updatedAt });
    if (error && (error.message ?? "").startsWith("USER: Changed by")) throw new ActionError(error.message.slice(6), { code: "conflict" });
    throwIfDbError(error);
    const r = data as { display_name: string; client_code: string; tasks: number; documents: number; invoices: number; whatsapp_groups: number; deleted_at: string };
    await ctx.audit({ event: "data_delete", resourceType: "client", resourceId: input.clientId, details: r });
    return ok({ display_name: r.display_name, client_code: r.client_code, tasks: r.tasks, documents: r.documents });
  },
);

// =================================================================================================
// Bulk actions (§7.3.1: assign owner, add to group, change status, export)
// =================================================================================================

export type BulkResult = { changed: number; skipped: Array<{ id: string; name: string; reason: string }> };

export const bulkChangeStatus = defineAction(
  { name: "clients.bulk_status", schema: BulkStatusSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<BulkResult>> => {
    const clients = await getClientsBrief(ctx.supabase, input.clientIds);
    const skipped: BulkResult["skipped"] = [];
    let changed = 0;
    for (const c of clients) {
      if (c.deleted_at) {
        skipped.push({ id: c.id, name: c.display_name, reason: "It's in the recycle bin." });
        continue;
      }
      if (c.status === input.to) {
        skipped.push({ id: c.id, name: c.display_name, reason: `It's already ${STATUS_LABEL[input.to]}.` });
        continue;
      }
      const { error } = await ctx.supabase.rpc("change_client_status", { p_client_id: c.id, p_to: input.to, p_reason: input.reason, p_updated_at: null });
      if (error) {
        skipped.push({ id: c.id, name: c.display_name, reason: (error.message ?? "").startsWith("USER: ") ? error.message.slice(6) : "It couldn't be changed." });
        continue;
      }
      changed++;
    }
    await ctx.audit({ event: "data_update", resourceType: "client", action: "clients.bulk_status", details: { to: input.to, reason: input.reason, client_ids: input.clientIds, changed } });
    return ok({ changed, skipped });
  },
);

export const bulkAssignOwner = defineAction(
  { name: "clients.bulk_owner", schema: BulkOwnerSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<BulkResult>> => {
    const { data: owner, error: oErr } = await ctx.supabase.from("employees").select("id, full_name, is_active, deleted_at").eq("id", input.ownerEmployeeId).maybeSingle();
    throwIfDbError(oErr);
    if (!owner || !owner.is_active || owner.deleted_at) return fail("Choose an active member of the team as the owner.", { code: "validation", fieldErrors: { ownerEmployeeId: ["Choose an active member of the team."] } });
    const clients = (await getClientsBrief(ctx.supabase, input.clientIds)).filter((c) => !c.deleted_at);
    const moving = clients.filter((c) => c.owner_employee_id !== owner.id);
    const skipped = clients.filter((c) => c.owner_employee_id === owner.id).map((c) => ({ id: c.id, name: c.display_name, reason: `${owner.full_name} already owns it.` }));
    if (moving.length) {
      const { error } = await ctx.supabase.from("clients").update({ owner_employee_id: owner.id }).in("id", moving.map((c) => c.id));
      throwIfDbError(error);
    }
    await ctx.audit({
      event: "data_update",
      resourceType: "client",
      action: "clients.bulk_owner",
      details: { owner_employee_id: owner.id, changes: moving.map((c) => ({ id: c.id, before: c.owner_employee_id, after: owner.id })) },
    });
    ctx.after("Add to the clients' timelines", async () => {
      for (const c of moving) await addTimelineEvent({ clientId: c.id, eventType: "employee_assigned", title: `Owner changed to ${owner.full_name}` });
    });
    if (moving.length) {
      ctx.after(
        "Tell the new owner",
        () =>
          notify({
            to: { employeeIds: [owner.id] },
            type: "info",
            title: moving.length === 1 ? `You now own ${moving[0].display_name}` : `You now own ${moving.length} more clients`,
            body: moving.length === 1 ? `${moving[0].display_name} (${moving[0].client_code}) was assigned to you.` : moving.map((c) => c.display_name).slice(0, 10).join(", "),
            linkUrl: moving.length === 1 ? `/clients/${moving[0].id}` : `/clients?owner=${owner.id}`,
            entity: moving.length === 1 ? { type: "client", id: moving[0].id } : null,
            clientId: moving.length === 1 ? moving[0].id : null,
          }),
        "The new owner wasn't notified. Let them know.",
      );
    }
    return ok({ changed: moving.length, skipped });
  },
);

export const bulkAddToGroup = defineAction(
  { name: "clients.bulk_group", schema: BulkGroupSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<BulkResult>> => {
    let groupName: string | null = null;
    if (input.groupId) {
      const { data: g, error } = await ctx.supabase.from("client_groups").select("id, name").eq("id", input.groupId).maybeSingle();
      throwIfDbError(error);
      if (!g) return fail("That group no longer exists.", { code: "not_found" });
      groupName = String(g.name);
    }
    const clients = (await getClientsBrief(ctx.supabase, input.clientIds)).filter((c) => !c.deleted_at);
    const moving = clients.filter((c) => c.group_id !== input.groupId);
    if (moving.length) {
      const { error } = await ctx.supabase.from("clients").update({ group_id: input.groupId }).in("id", moving.map((c) => c.id));
      throwIfDbError(error);
    }
    await ctx.audit({
      event: "data_update",
      resourceType: "client",
      action: "clients.bulk_group",
      details: { group_id: input.groupId, changes: moving.map((c) => ({ id: c.id, before: c.group_id, after: input.groupId })) },
    });
    ctx.after("Add to the clients' timelines", async () => {
      for (const c of moving) {
        await addTimelineEvent({ clientId: c.id, eventType: "client_group_changed", title: groupName ? `Added to the group ${groupName}` : "Removed from its client group" });
      }
    });
    return ok({
      changed: moving.length,
      skipped: clients.filter((c) => c.group_id === input.groupId).map((c) => ({ id: c.id, name: c.display_name, reason: groupName ? `It's already in ${groupName}.` : "It isn't in a group." })),
    });
  },
);

// =================================================================================================
// Export (§7.3.4 "CSV/Excel export of the current view; Employees can't export fees")
// =================================================================================================

export type ExportFile = { fileName: string; mimeType: string; base64: string; rows: number; truncated: boolean };

export const exportClients = defineAction(
  { name: "clients.export", schema: ExportClientsSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<ExportFile>> => {
    const seesMoney = isManagerOrPartner(ctx.user.role);
    const t = parseTableParams(new URLSearchParams(input.query), {
      sortable: CLIENT_LIST_SORTABLE,
      defaultSort: { sort: "display_name", dir: "asc" },
      filters: CLIENT_LIST_FILTERS,
    });
    let ids = input.ids;
    if (t.filters.covering) {
      // "Clients I'm covering" (§4.7): the view's clients are the ones reached by the viewer's covers in force.
      const covered = ctx.user.employeeId ? [...(await getMyCoveredClients(ctx.supabase, ctx.user.employeeId)).keys()] : [];
      ids = ids ? ids.filter((id) => covered.includes(id)) : covered;
    }
    const { rows, truncated } = await listClientsForExport(ctx.supabase, t, { seesMoney, ids });
    const table = clientExportTable(rows, { withMoney: seesMoney, istDate: (ts) => (ts ? istDateOf(ts) : "") });
    const stamp = todayIST();
    let base64: string;
    let mimeType: string;
    let fileName: string;
    if (input.format === "xlsx") {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "TaxWise Consultants";
      wb.created = new Date();
      const ws = wb.addWorksheet("Clients", { views: [{ state: "frozen", ySplit: 1 }] });
      ws.addRow(table.header);
      ws.getRow(1).font = { bold: true };
      for (const r of table.rows) ws.addRow(r);
      ws.columns.forEach((col, i) => {
        const h = table.header[i] ?? "";
        col.width = Math.min(48, Math.max(10, h.length + 2));
        if (h === "Outstanding (₹)") col.numFmt = "#,##,##0.00";
      });
      const buf = await wb.xlsx.writeBuffer();
      base64 = Buffer.from(buf as ArrayBuffer).toString("base64");
      mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      fileName = `taxwise-clients-${stamp}.xlsx`;
    } else {
      base64 = Buffer.from(toCsv(table.header, table.rows), "utf8").toString("base64");
      mimeType = "text/csv;charset=utf-8";
      fileName = `taxwise-clients-${stamp}.csv`;
    }
    await ctx.audit({
      event: "export_run",
      resourceType: "clients",
      details: { format: input.format, rows: rows.length, truncated, query: input.query, selected: input.ids?.length ?? null, with_fees: seesMoney },
    });
    return ok({ fileName, mimeType, base64, rows: rows.length, truncated });
  },
);

// =================================================================================================
// Saved views of the client list (§3.4)
// =================================================================================================

export const saveClientView = defineAction(
  { name: "clients.views.save", schema: SaveClientViewSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const shared = input.shared && isManagerOrPartner(ctx.user.role);
    const { data, error } = await ctx.supabase
      .from("saved_views")
      .upsert({ user_id: ctx.user.id, page: "clients", name: input.name, filters: { query: input.query }, is_shared: shared }, { onConflict: "user_id,page,name" })
      .select("id")
      .single();
    throwIfDbError(error, { uniqueField: "name", uniqueMessage: "You already have a view with this name." });
    await ctx.audit({ event: "data_update", resourceType: "saved_view", resourceId: data!.id, details: { page: "clients", name: input.name, shared } });
    return ok({ id: data!.id });
  },
);

export const deleteClientView = defineAction(
  { name: "clients.views.delete", schema: DeleteClientViewSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("saved_views").delete().eq("id", input.id).eq("user_id", ctx.user.id).select("id");
    throwIfDbError(error);
    if (data?.length) await ctx.audit({ event: "data_delete", resourceType: "saved_view", resourceId: input.id, details: { page: "clients" } });
    return ok({ id: input.id });
  },
);
