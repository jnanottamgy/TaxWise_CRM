"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { log } from "@/lib/log";
import { formatDate } from "@/lib/format";
import { compareDates, isFinancialYear, istDateOf, nextFinancialYear, todayIST } from "@/lib/domain/fy";
import { SERVICE_TYPE_LABELS, type EngagementStatus, type ServiceType } from "@/lib/domain/enums";
import { firstNameOf } from "@/lib/domain/messaging";
import type { EmailSendOutcome } from "@/lib/handoff";
import type { Json, TablesUpdate } from "@/lib/database.types";
import { getLetter, getLetterClientContext, getLetterDocument, type LetterClientContext, type LetterRow } from "@/lib/data/engagement-letters";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";
import { getFirmProfile } from "@/server/firm";
import { sendEmail } from "@/server/email/send";
import { emailFirm } from "@/server/email/templates/layout";
import { engagementLetterEmail } from "@/server/email/templates";
import { buildEngagementLetterPdf } from "@/server/pdf/engagement-letter";
import {
  AttachSignedCopySchema,
  CreateLetterSchema,
  DeclineLetterSchema,
  IssueLetterSchema,
  LETTER_AUDIT_TYPE_LABEL,
  LetterClientContextSchema,
  LetterRefSchema,
  RenewLetterSchema,
  SendLetterSchema,
  SignLetterSchema,
  UpdateLetterSchema,
  canMoveLetter,
  defaultLetterExpiry,
  defaultReportForm,
  defaultReportingFramework,
  isAuditLetter,
  istNoon,
  renewalOf,
  scheduleFromServices,
  type LetterAuditType,
  type ScheduleRow,
} from "@/lib/schemas/engagement-letters";

/**
 * Engagement letters (§7.15.3, §6.8 SA 210, §4.1 Partners and Managers only; RLS 0034 refuses anyone
 * else, and the guard in 0193 keeps the lifecycle and freezes what the client signs).
 *
 *   createLetter / updateLetter   a Draft: client, FY, services, scope / exclusions, fee (excl.
 *                                 GST), the services schedule, the SA 210 terms for an audit, the
 *                                 signing Partner, expiry, notes. Edits carry updated_at (§13).
 *   issueLetter                   Draft → Issued on a date (not in the future).
 *   sendLetterEmail               emails the PDF for signature with the engagement-letter template
 *                                 (§10.13); a Draft is issued first. The outcome says whether it
 *                                 went, so the screen can offer Gmail or a download instead.
 *   recordLetterHandoff           a Gmail / WhatsApp hand-off of the letter, logged as "handed off".
 *   signLetter                    Issued → Signed on a date, with the signed copy from the vault.
 *   attachSignedCopy              the signed copy, uploaded later.
 *   declineLetter                 Issued → Declined, with the client's reason.
 *   withdrawLetter                Issued or Declined → Draft, to change and issue again.
 *   renewLetter                   "Renew for next FY": a Draft for the next FY copying scope and
 *                                 services (once per letter).
 *   deleteLetterDraft             a Draft only.
 *   loadLetterClient              the client's active services (with fees), letters and audit
 *                                 engagements, to prefill a new letter.
 * Every change writes an audit row and an engagement_letter_* timeline entry (money side: Employees
 * never see it, §4.1).
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This letter was changed by someone else. Reload to see their changes.";

const STATUS_WORD: Record<EngagementStatus, string> = { draft: "Draft", issued: "Issued", signed: "Signed", declined: "Declined", expired: "Expired" };

function servicesText(types: readonly ServiceType[]): string {
  return types.map((t) => SERVICE_TYPE_LABELS[t]).join(", ");
}

async function loadLetter(ctx: ActionContext, id: string): Promise<LetterRow> {
  const letter = await getLetter(ctx.supabase, id);
  if (!letter) throw new ActionError("That engagement letter doesn't exist any more, or its client is in the recycle bin.", { code: "not_found" });
  return letter;
}

function sameStamp(a: string, b: string): boolean {
  return a === b || new Date(a).getTime() === new Date(b).getTime();
}

function guardMove(letter: LetterRow, to: EngagementStatus) {
  if (!canMoveLetter(letter.status, to)) {
    throw new ActionError(`This letter is ${STATUS_WORD[letter.status]}, so it can't be ${to === "draft" ? "withdrawn to a draft" : `marked ${STATUS_WORD[to]}`}.`, { code: "blocked" });
  }
}

function throwLetterError(error: { code?: string; message?: string } | null) {
  throwIfDbError(error);
}

/** Updates the letter where it still has the updated_at the screen loaded; returns the new stamp or fails with a conflict. */
async function updateWhere(ctx: ActionContext, id: string, updatedAt: string, patch: TablesUpdate<"engagement_letters">): Promise<string> {
  const { data, error } = await ctx.supabase.from("engagement_letters").update(patch).eq("id", id).eq("updated_at", updatedAt).select("id, updated_at");
  throwLetterError(error);
  const row = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
  if (!row) throw new ActionError(STALE, { code: "conflict" });
  return row.updated_at;
}

async function liveClient(ctx: ActionContext, clientId: string): Promise<{ id: string; display_name: string; status: string }> {
  const { data, error } = await ctx.supabase.from("clients").select("id, display_name, status, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found", fieldErrors: { clientId: ["Choose a client from the list."] } });
  return data;
}

type LetterValues = {
  financialYear: string;
  serviceTypes: ServiceType[];
  scope: string | null;
  exclusions: string | null;
  feeAgreed: string | null;
  servicesSchedule: Array<{ service_type: ServiceType; description: string; frequency: ScheduleRow["frequency"]; fee: string | null }>;
  expiresAt: string | null;
  auditType: LetterAuditType | null;
  reportingFramework: string | null;
  reportForm: string | null;
  auditEngagementId: string | null;
  signatoryId: string | null;
  notes: string | null;
};

/** A numeric(14,2) as its exact decimal string: PostgREST casts it, so no float carries the amount (§0.1 rule 7). */
function asNumeric(decimal: string | null): number | null {
  return decimal as unknown as number | null;
}

function columns(v: LetterValues) {
  const audit = isAuditLetter(v.serviceTypes);
  return {
    financial_year: v.financialYear,
    service_types: v.serviceTypes,
    scope: v.scope,
    exclusions: v.exclusions,
    fee_agreed: asNumeric(v.feeAgreed),
    services_schedule: v.servicesSchedule as unknown as Json,
    expires_at: v.expiresAt ?? defaultLetterExpiry(v.financialYear, audit),
    audit_type: audit ? v.auditType : null,
    reporting_framework: audit ? v.reportingFramework : null,
    report_form: audit ? v.reportForm : null,
    audit_engagement_id: audit ? v.auditEngagementId : null,
    signatory_id: v.signatoryId,
    notes: v.notes,
  };
}

/** Warnings worth saying on save: another live letter for the same FY covering the same services; an expiry before the FY ends. */
async function saveWarnings(ctx: ActionContext, clientId: string, v: LetterValues, exceptId: string | null): Promise<string[]> {
  const out: string[] = [];
  const { data, error } = await ctx.supabase.from("engagement_letters").select("id, service_types, status").eq("client_id", clientId).eq("financial_year", v.financialYear).neq("status", "declined");
  throwIfDbError(error);
  const overlap = (data ?? []).filter((l) => l.id !== exceptId && (l.service_types as ServiceType[]).some((s) => v.serviceTypes.includes(s)));
  if (overlap.length) out.push(`This client already has ${overlap.length === 1 ? "a letter" : `${overlap.length} letters`} for FY ${v.financialYear} covering some of the same services. Check you need both.`);
  const expiry = v.expiresAt ?? defaultLetterExpiry(v.financialYear, isAuditLetter(v.serviceTypes));
  if (isFinancialYear(v.financialYear) && compareDates(expiry, `${v.financialYear.slice(0, 4)}-04-01`) < 0) out.push(`The expiry date ${formatDate(expiry)} is before FY ${v.financialYear} begins.`);
  return out;
}

export const loadLetterClient = defineAction(
  { name: "engagement_letters.client_context", schema: LetterClientContextSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<LetterClientContext & { schedule: ScheduleRow[] }>> => {
    const context = await getLetterClientContext(ctx.supabase, input.clientId);
    if (!context) return fail("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
    return ok({ ...context, schedule: scheduleFromServices(context.services.filter((s) => s.service_type !== "audit")) });
  },
);

export const createLetter = defineAction(
  { name: "engagement_letters.create", schema: CreateLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const client = await liveClient(ctx, input.clientId);
    const values = input as LetterValues;
    const warnings = await saveWarnings(ctx, client.id, values, null);
    const { data, error } = await ctx.supabase
      .from("engagement_letters")
      .insert({ client_id: client.id, status: "draft", ...columns(values) })
      .select("id")
      .single();
    throwLetterError(error);
    const id = (data as { id: string }).id;
    await ctx.audit({
      event: "data_create",
      resourceType: "engagement_letter",
      resourceId: id,
      details: { client_id: client.id, financial_year: input.financialYear, service_types: input.serviceTypes, fee_agreed: input.feeAgreed, audit_type: input.auditType },
    });
    ctx.after("Add the letter to the client's timeline", () =>
      addTimelineEvent({ clientId: client.id, eventType: "engagement_letter_drafted", title: `Engagement letter for FY ${input.financialYear} drafted (${servicesText(input.serviceTypes)})`, metadata: { engagement_letter_id: id } }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "client_updated", description: `Drafted the FY ${input.financialYear} engagement letter for ${client.display_name}`, entityType: "client", entityId: client.id, entityName: client.display_name }),
    );
    return ok({ id }, warnings);
  },
);

export const updateLetter = defineAction(
  { name: "engagement_letters.update", schema: UpdateLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const before = await loadLetter(ctx, input.id);
    if (!sameStamp(before.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    if (before.status !== "draft") {
      return fail(`This letter is ${STATUS_WORD[before.status]}: what the client signs can't change. Withdraw it to a draft first, or renew it for the next FY.`, { code: "blocked" });
    }
    const values = input as LetterValues;
    const warnings = await saveWarnings(ctx, before.client_id, values, before.id);
    const updatedAt = await updateWhere(ctx, input.id, input.updatedAt, columns(values));
    const changed: string[] = [];
    if (before.financial_year !== input.financialYear) changed.push("FY");
    if (servicesText(before.service_types) !== servicesText(input.serviceTypes)) changed.push("services");
    if ((before.fee_agreed === null ? null : Number(before.fee_agreed)) !== (input.feeAgreed === null ? null : Number(input.feeAgreed))) changed.push("fee");
    if ((before.scope ?? null) !== input.scope || (before.exclusions ?? null) !== input.exclusions) changed.push("scope");
    await ctx.audit({ event: "data_update", resourceType: "engagement_letter", resourceId: input.id, details: { client_id: before.client_id, changed, fee_agreed: input.feeAgreed } });
    return ok({ id: input.id, updatedAt }, warnings);
  },
);

export const issueLetter = defineAction(
  { name: "engagement_letters.issue", schema: IssueLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    guardMove(letter, "issued");
    if (compareDates(input.issuedOn, todayIST()) > 0) return fail("The issue date can't be in the future.", { code: "validation", fieldErrors: { issuedOn: ["The issue date can't be in the future."] } });
    if (isAuditLetter(letter.service_types) && (!letter.reporting_framework || !letter.report_form || !letter.audit_type)) {
      return fail("An audit letter needs the kind of audit, the reporting framework and the form of report (SA 210). Edit the draft first.", { code: "blocked" });
    }
    const warnings: string[] = [];
    if (!letter.signatory_id) warnings.push("No signing Partner is named on the letter: the signature block prints without a name.");
    const updatedAt = await updateWhere(ctx, input.id, input.updatedAt, { status: "issued", issued_at: istNoon(input.issuedOn) });
    await ctx.audit({ event: "data_update", resourceType: "engagement_letter", resourceId: input.id, action: "engagement_letters.issue", details: { client_id: letter.client_id, financial_year: letter.financial_year, issued_on: input.issuedOn } });
    ctx.after("Add the issue to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_issued", title: `Engagement letter for FY ${letter.financial_year} issued on ${formatDate(input.issuedOn)}`, metadata: { engagement_letter_id: letter.id } }),
    );
    return ok({ id: input.id, updatedAt }, warnings);
  },
);

export type SendLetterResult = { email: EmailSendOutcome; updatedAt: string; issued: boolean };

export const sendLetterEmail = defineAction(
  { name: "engagement_letters.send", schema: SendLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<SendLetterResult>> => {
    let letter = await loadLetter(ctx, input.id);
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    if (letter.status !== "draft" && letter.status !== "issued") {
      return fail(`This letter is ${STATUS_WORD[letter.status]}, so there's nothing to send for signature.`, { code: "blocked" });
    }
    let recipientName = "";
    if (input.contactId) {
      const { data: contact, error } = await ctx.supabase.from("client_contacts").select("name, client_id").eq("id", input.contactId).maybeSingle();
      throwIfDbError(error);
      if (!contact || contact.client_id !== letter.client_id) return fail("That contact isn't one of this client's contacts.", { code: "validation", fieldErrors: { contactId: ["Choose one of the client's contacts."] } });
      recipientName = contact.name;
    }

    // A draft is issued as it goes out (§7.15.3 Draft → Issued).
    let issued = false;
    let updatedAt = letter.updated_at;
    if (letter.status === "draft") {
      if (isAuditLetter(letter.service_types) && (!letter.reporting_framework || !letter.report_form || !letter.audit_type)) {
        return fail("An audit letter needs the kind of audit, the reporting framework and the form of report (SA 210). Edit the draft first.", { code: "blocked" });
      }
      updatedAt = await updateWhere(ctx, letter.id, input.updatedAt, { status: "issued", issued_at: istNoon(todayIST()) });
      issued = true;
      const reloaded = await getLetter(ctx.supabase, letter.id);
      if (reloaded) letter = reloaded;
    }

    const email = await emailLetter(ctx, { letter, to: input.to, contactId: input.contactId, recipientName, key: `engagement_letter:${letter.id}:send:${input.nonce}` });
    if (email.status === "sent") {
      const { data, error } = await ctx.supabase.from("engagement_letters").update({ sent_at: new Date().toISOString(), sent_to: input.to }).eq("id", letter.id).select("updated_at");
      if (error) log("error", "engagement letter send not recorded on the letter", { source: "action:engagement_letters.send", userId: ctx.user.id, letterId: letter.id, err: error });
      else updatedAt = ((data ?? [])[0] as { updated_at: string } | undefined)?.updated_at ?? updatedAt;
    }
    await ctx.audit({
      event: "data_update",
      resourceType: "engagement_letter",
      resourceId: letter.id,
      action: "engagement_letters.send",
      details: { client_id: letter.client_id, financial_year: letter.financial_year, to: input.to, outcome: email.status, issued },
      success: email.status === "sent",
      error: email.status === "sent" ? undefined : email.error,
    });
    if (issued) {
      ctx.after("Add the issue to the client's timeline", () =>
        addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_issued", title: `Engagement letter for FY ${letter.financial_year} issued`, metadata: { engagement_letter_id: letter.id } }),
      );
    }
    if (email.status === "sent") {
      ctx.after("Add the email to the client's timeline", () =>
        addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_sent", title: `Engagement letter for FY ${letter.financial_year} emailed for signature to ${input.to}`, metadata: { engagement_letter_id: letter.id } }),
      );
    }
    return ok({ email, updatedAt, issued });
  },
);

/** Renders the PDF and sends it with the §10.13 template. Never throws: the outcome says what happened. */
async function emailLetter(ctx: ActionContext, p: { letter: LetterRow; to: string; contactId: string | null; recipientName: string; key: string }): Promise<EmailSendOutcome> {
  try {
    const [doc, firmProfile] = await Promise.all([getLetterDocument(ctx.supabase, p.letter.id), getFirmProfile(ctx.supabase)]);
    if (!doc) return { status: "failed", error: "The letter couldn't be read to attach it." };
    const firm = emailFirm(firmProfile);
    const audit = isAuditLetter(p.letter.service_types);
    const services = p.letter.services_schedule.length
      ? p.letter.services_schedule.map((s) => s.description)
      : p.letter.service_types.map((t) => (t === "audit" && p.letter.audit_type ? (LETTER_AUDIT_TYPE_LABEL[p.letter.audit_type as LetterAuditType] ?? SERVICE_TYPE_LABELS[t]) : SERVICE_TYPE_LABELS[t]));
    if (audit && p.letter.services_schedule.length && p.letter.audit_type) services.unshift(LETTER_AUDIT_TYPE_LABEL[p.letter.audit_type as LetterAuditType] ?? "Audit");
    const recipient = p.recipientName || doc.primaryContact?.name || doc.client.name;
    const mail = engagementLetterEmail(
      {
        recipientName: firstNameOf(recipient) || recipient,
        clientName: doc.client.legalName ?? doc.client.name,
        financialYear: p.letter.financial_year,
        services,
        uploadUrl: null,
        expiresOn: p.letter.expires_at,
        partnerName: doc.signatory?.name ?? ctx.user.fullName,
        isAudit: audit,
      },
      firm,
    );
    const pdf = await buildEngagementLetterPdf({ firm: firmProfile, doc });
    const r = await sendEmail({
      to: p.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "engagement_letter",
      clientId: p.letter.client_id,
      contactId: p.contactId,
      related: { type: "engagement_letter", id: p.letter.id },
      attachments: [{ filename: pdf.fileName, content: pdf.bytes, contentType: "application/pdf" }],
      idempotencyKey: p.key,
    });
    return { status: r.status, error: r.error };
  } catch (err) {
    log("error", "engagement letter email failed", { source: "action:engagement_letters.send", userId: ctx.user.id, letterId: p.letter.id, err });
    return { status: "failed", error: "The letter email couldn't be prepared. Download the PDF and send it from your own mailbox instead." };
  }
}

const HandoffSchema = z.object({
  id: z.uuid(),
  channel: z.enum(["gmail_handoff", "whatsapp_handoff"]),
  contactId: z
    .union([z.uuid(), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  recipient: z.string().trim().min(3).max(200),
  subject: z.string().trim().max(300).optional().nullable(),
  body: z.string().trim().min(1).max(4000),
});

export const recordLetterHandoff = defineAction(
  { name: "engagement_letters.handoff", schema: HandoffSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ messageId: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (letter.status !== "issued" && letter.status !== "draft") return fail(`This letter is ${STATUS_WORD[letter.status]}, so there's nothing to send for signature.`, { code: "blocked" });
    if (input.contactId) {
      const { data: c, error } = await ctx.supabase.from("client_contacts").select("client_id").eq("id", input.contactId).maybeSingle();
      throwIfDbError(error);
      if (!c || c.client_id !== letter.client_id) return fail("That contact isn't one of this client's contacts.", { code: "validation" });
    }
    const { data, error } = await ctx.supabase
      .from("messages")
      .insert({
        client_id: letter.client_id,
        contact_id: input.contactId,
        channel: input.channel,
        direction: "outbound",
        recipient: input.recipient,
        subject: input.subject ?? null,
        body: input.body,
        status: "handed_off",
        related_entity_type: "engagement_letter",
        related_entity_id: letter.id,
        sent_by: ctx.user.id,
        sent_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    throwIfDbError(error);
    const messageId = (data as { id: string }).id;
    await ctx.audit({ event: "data_create", resourceType: "message", resourceId: messageId, action: "engagement_letters.handoff", details: { channel: input.channel, engagement_letter_id: letter.id } });
    const name = input.channel === "gmail_handoff" ? "Gmail" : "WhatsApp";
    ctx.after("Record the hand-off event", async () => {
      const { error: evError } = await ctx.supabase.from("message_events").insert({ message_id: messageId, status: "handed_off", details: { channel: input.channel } });
      if (evError) throw evError;
    });
    ctx.after("Add the hand-off to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_handed_off", title: `Engagement letter for FY ${letter.financial_year} handed off on ${name} to ${input.recipient}`, metadata: { message_id: messageId, engagement_letter_id: letter.id } }),
    );
    return ok({ messageId });
  },
);

async function documentOfClient(ctx: ActionContext, documentId: string, clientId: string): Promise<{ id: string; title: string }> {
  const { data, error } = await ctx.supabase.from("documents").select("id, client_id, title, deleted_at").eq("id", documentId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at || data.client_id !== clientId) {
    throw new ActionError("That signed copy isn't in this client's document vault. Upload it again.", { code: "validation", fieldErrors: { documentId: ["Upload the signed copy again."] } });
  }
  return { id: data.id, title: data.title };
}

export const signLetter = defineAction(
  { name: "engagement_letters.sign", schema: SignLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    guardMove(letter, "signed");
    if (compareDates(input.signedOn, todayIST()) > 0) return fail("The signing date can't be in the future.", { code: "validation", fieldErrors: { signedOn: ["The signing date can't be in the future."] } });
    if (letter.issued_at && compareDates(input.signedOn, istDateOf(letter.issued_at)) < 0) {
      return fail(`The letter was issued on ${formatDate(istDateOf(letter.issued_at))}; it can't be signed before that.`, { code: "validation", fieldErrors: { signedOn: ["It can't be signed before it was issued."] } });
    }
    const doc = input.documentId ? await documentOfClient(ctx, input.documentId, letter.client_id) : null;
    const updatedAt = await updateWhere(ctx, input.id, input.updatedAt, { status: "signed", signed_at: istNoon(input.signedOn), ...(doc ? { document_id: doc.id } : {}) });
    await ctx.audit({ event: "data_update", resourceType: "engagement_letter", resourceId: input.id, action: "engagement_letters.sign", details: { client_id: letter.client_id, financial_year: letter.financial_year, signed_on: input.signedOn, document_id: doc?.id ?? null } });
    ctx.after("Add the signature to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_signed", title: `Engagement letter for FY ${letter.financial_year} signed by the client on ${formatDate(input.signedOn)}`, metadata: { engagement_letter_id: letter.id, document_id: doc?.id ?? null } }),
    );
    return ok({ id: input.id, updatedAt }, doc ? undefined : ["Marked signed. Upload the signed copy so it's kept in the vault."]);
  },
);

export const attachSignedCopy = defineAction(
  { name: "engagement_letters.attach_signed_copy", schema: AttachSignedCopySchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    if (letter.status !== "signed" && letter.status !== "issued") return fail("The signed copy goes on an issued or signed letter.", { code: "blocked" });
    const doc = await documentOfClient(ctx, input.documentId, letter.client_id);
    const updatedAt = await updateWhere(ctx, input.id, input.updatedAt, { document_id: doc.id });
    await ctx.audit({ event: "data_update", resourceType: "engagement_letter", resourceId: input.id, action: "engagement_letters.signed_copy", details: { client_id: letter.client_id, document_id: doc.id } });
    ctx.after("Add the signed copy to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_signed_copy", title: `Signed engagement letter for FY ${letter.financial_year} filed in the vault: ${doc.title}`, metadata: { engagement_letter_id: letter.id, document_id: doc.id } }),
    );
    return ok({ id: input.id, updatedAt });
  },
);

export const declineLetter = defineAction(
  { name: "engagement_letters.decline", schema: DeclineLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    guardMove(letter, "declined");
    const updatedAt = await updateWhere(ctx, input.id, input.updatedAt, { status: "declined", declined_reason: input.reason });
    await ctx.audit({ event: "data_update", resourceType: "engagement_letter", resourceId: input.id, action: "engagement_letters.decline", details: { client_id: letter.client_id, financial_year: letter.financial_year, reason: input.reason } });
    ctx.after("Add the decline to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_declined", title: `Engagement letter for FY ${letter.financial_year} declined by the client`, description: input.reason, metadata: { engagement_letter_id: letter.id } }),
    );
    return ok({ id: input.id, updatedAt });
  },
);

export const withdrawLetter = defineAction(
  { name: "engagement_letters.withdraw", schema: LetterRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    guardMove(letter, "draft");
    const updatedAt = await updateWhere(ctx, input.id, input.updatedAt, { status: "draft" });
    await ctx.audit({ event: "data_update", resourceType: "engagement_letter", resourceId: input.id, action: "engagement_letters.withdraw", details: { client_id: letter.client_id, from: letter.status } });
    ctx.after("Add the withdrawal to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_withdrawn", title: `Engagement letter for FY ${letter.financial_year} withdrawn to a draft`, metadata: { engagement_letter_id: letter.id } }),
    );
    return ok({ id: input.id, updatedAt }, letter.status === "issued" ? ["The client may still have the issued letter. Tell them a revised one is coming."] : undefined);
  },
);

export const renewLetter = defineAction(
  { name: "engagement_letters.renew", schema: RenewLetterSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; financialYear: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (letter.status !== "issued" && letter.status !== "signed" && letter.status !== "expired") {
      return fail("Only an issued or signed letter is renewed. Edit the draft instead.", { code: "blocked" });
    }
    if (letter.renewal_id) {
      return fail(`It was already renewed for FY ${letter.renewal_fy ?? nextFinancialYear(letter.financial_year)}. Open that letter instead.`, { code: "conflict" });
    }
    const client = await liveClient(ctx, letter.client_id);
    const next = renewalOf(letter);
    // The signatory must still be an active Partner; otherwise the renewal starts without one.
    let signatory = next.signatory_id;
    if (signatory) {
      const { data: p, error } = await ctx.supabase.from("profiles").select("id, role, is_active").eq("id", signatory).maybeSingle();
      throwIfDbError(error);
      if (!p || p.role !== "partner" || !p.is_active) signatory = null;
    }
    const { data, error } = await ctx.supabase
      .from("engagement_letters")
      .insert({
        client_id: client.id,
        status: "draft",
        financial_year: next.financial_year,
        service_types: next.service_types,
        scope: next.scope,
        exclusions: next.exclusions,
        fee_agreed: asNumeric(next.fee_agreed),
        services_schedule: next.services_schedule as unknown as Json,
        audit_type: next.audit_type,
        reporting_framework: next.reporting_framework ?? (next.audit_type ? defaultReportingFramework(next.audit_type as LetterAuditType, null, next.financial_year) : null),
        report_form: next.report_form ?? (next.audit_type ? defaultReportForm(next.audit_type as LetterAuditType, next.financial_year) : null),
        signatory_id: signatory,
        expires_at: next.expires_at,
        renewed_from_id: letter.id,
        notes: letter.notes,
      })
      .select("id")
      .single();
    throwLetterError(error);
    const id = (data as { id: string }).id;
    await ctx.audit({ event: "data_create", resourceType: "engagement_letter", resourceId: id, action: "engagement_letters.renew", details: { client_id: client.id, renewed_from: letter.id, financial_year: next.financial_year } });
    ctx.after("Add the renewal to the client's timeline", () =>
      addTimelineEvent({ clientId: client.id, eventType: "engagement_letter_renewed", title: `Engagement letter renewed for FY ${next.financial_year} as a draft, from FY ${letter.financial_year}`, metadata: { engagement_letter_id: id, renewed_from: letter.id } }),
    );
    const warnings: string[] = [];
    if (letter.signatory_id && !signatory) warnings.push("The Partner who signed last year's letter isn't an active Partner now. Choose the signing Partner on the draft.");
    if (next.fee_agreed) warnings.push("Fees were copied from last year's letter. Check them before issuing.");
    return ok({ id, financialYear: next.financial_year }, warnings);
  },
);

export const deleteLetterDraft = defineAction(
  { name: "engagement_letters.delete_draft", schema: LetterRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const letter = await loadLetter(ctx, input.id);
    if (letter.status !== "draft") return fail("Only a draft can be deleted. An issued letter stays on record.", { code: "blocked" });
    if (!sameStamp(letter.updated_at, input.updatedAt)) return fail(STALE, { code: "conflict" });
    const { data, error } = await ctx.supabase.from("engagement_letters").delete().eq("id", input.id).eq("updated_at", input.updatedAt).eq("status", "draft").select("id");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_delete", resourceType: "engagement_letter", resourceId: input.id, details: { client_id: letter.client_id, financial_year: letter.financial_year } });
    ctx.after("Add the deletion to the client's timeline", () =>
      addTimelineEvent({ clientId: letter.client_id, eventType: "engagement_letter_deleted", title: `Draft engagement letter for FY ${letter.financial_year} deleted`, metadata: { engagement_letter_id: letter.id } }),
    );
    return ok({ id: input.id });
  },
);
