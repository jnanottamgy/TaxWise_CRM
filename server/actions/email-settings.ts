"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatDate, formatTime } from "@/lib/format";
import { getProfileNames } from "@/lib/data/settings";
import { DomainRefreshSchema, DomainRemoveSchema, DomainSetupSchema, SenderSchema, TestSendSchema } from "@/components/settings/email/schemas";
import { createDomain, removeDomain, resendConfigured, verifyDomain } from "@/server/email/resend";
import { describeSendError, emailDomainOf, fromAddressOnDomain, type DomainStatus } from "@/server/email/policy";
import { getEmailSettingsView, lookUpDomain, mirrorDomain, toDomainDetails, type DomainDetails, type EmailSettingsView } from "@/server/email/settings-data";
import { sendEmail } from "@/server/email/send";
import { emailFirm } from "@/server/email/templates/layout";
import { testEmail } from "@/server/email/templates/notification";
import { getFirmProfile } from "@/server/firm";

/**
 * Settings → Email (§7.13.5, §7.21). Partner only (§4.1 "email domain"), refused for anyone else
 * here and by RLS.
 *
 *   startDomainSetup    adds the sending domain to Resend and shows its DNS records
 *   refreshDomainStatus reads the status from Resend (polling), or asks Resend to check now
 *   removeDomainSetup   removes the domain from Resend to start again with another name
 *   saveSenderSettings  from-name, from-address (on the sending domain), reply-to
 *   sendTestEmail       a test email to the signed-in Partner
 *
 * The domain's status is only ever what Resend said (written as the system after Resend answered;
 * the database refuses it from anyone else, 0100). Every change is audited (config_change).
 */

const RESOURCE = "firm_settings";

async function view(ctx: ActionContext): Promise<EmailSettingsView> {
  const v = await getEmailSettingsView(ctx.supabase);
  if (!v) throw new ActionError("The firm's settings row is missing. Ask whoever set up the database to run the database seed.", { code: "not_found" });
  return v;
}

function needResend() {
  if (!resendConfigured()) {
    throw new ActionError("RESEND_API_KEY isn't set on this deployment, so Resend can't be reached. Add it in the hosting settings and redeploy.", { code: "blocked" });
  }
}

export interface DomainActionResult {
  details: DomainDetails | null;
  status: DomainStatus;
  /** True when the stored status changed (the page refreshes its other sections). */
  changed: boolean;
  /** Said to the person after the action: e.g. that the from address moved to the new domain. */
  note: string | null;
}

// -------------------------------------------------------------------------------------------------
// Add the domain to Resend
// -------------------------------------------------------------------------------------------------

export const startDomainSetup = defineAction(
  { name: "settings.email.domain_create", schema: DomainSetupSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<DomainActionResult>> => {
    needResend();
    const v = await view(ctx);
    if (v.resendDomainId && v.sendingDomain.toLowerCase() !== input.domain) {
      throw new ActionError(`${v.sendingDomain} is already set up in Resend. Remove it first to switch to ${input.domain}.`, {
        code: "conflict",
        fieldErrors: { domain: [`Remove ${v.sendingDomain} first.`] },
      });
    }
    const created = await createDomain(input.domain, input.region);
    if (!created.ok) {
      const message = describeSendError(created.error);
      throw new ActionError(message, { code: "blocked", fieldErrors: created.error.name === "validation_error" ? { domain: [message] } : undefined });
    }
    const details = toDomainDetails(created.domain, v.replyTo || v.firmEmail);
    const changed = await mirrorDomain(
      { resendDomainId: v.resendDomainId, domainStatus: v.domainStatus, sendingDomain: v.sendingDomain, domainVerifiedAt: v.domainVerifiedAt },
      { id: details.id, name: details.name, status: details.status },
    );

    // The from address must be on the sending domain (Resend refuses anything else).
    let note: string | null = null;
    if (!fromAddressOnDomain(v.fromAddress, details.name)) {
      const local = v.fromAddress.split("@")[0] || "noreply";
      const nextFrom = `${local}@${details.name}`;
      const { error } = await ctx.supabase.from("firm_settings").update({ email_from_address: nextFrom, updated_by: ctx.user.id }).eq("id", 1);
      throwIfDbError(error);
      note = `The from address is now ${nextFrom}, so it's on ${details.name}. Change it under Sender if you prefer another name before the @.`;
    }

    await ctx.audit({
      event: "config_change",
      resourceType: RESOURCE,
      resourceId: "1",
      action: "settings.email.domain_create",
      details: { domain: details.name, region: input.region, resend_domain_id: details.id, resend_status: details.resendStatus, from_address_changed: Boolean(note) },
    });
    return ok({ details, status: details.status, changed, note });
  },
);

// -------------------------------------------------------------------------------------------------
// Read (and optionally re-check) the status
// -------------------------------------------------------------------------------------------------

export const refreshDomainStatus = defineAction(
  { name: "settings.email.domain_refresh", schema: DomainRefreshSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<DomainActionResult>> => {
    needResend();
    const v = await view(ctx);
    const current = { resendDomainId: v.resendDomainId, domainStatus: v.domainStatus, sendingDomain: v.sendingDomain, domainVerifiedAt: v.domainVerifiedAt };
    if (!v.resendDomainId) return ok({ details: null, status: v.domainStatus, changed: false, note: null });

    if (input.verify) {
      const asked = await verifyDomain(v.resendDomainId);
      if (!asked.ok && asked.error.statusCode !== 404) throw new ActionError(describeSendError(asked.error), { code: "blocked" });
    }
    const found = await lookUpDomain(v.resendDomainId, v.replyTo || v.firmEmail);
    if (!found.ok) {
      if (found.missing) {
        // Removed in Resend's dashboard: mirror that.
        const changed = await mirrorDomain(current, { id: null, name: v.sendingDomain, status: "not_started" });
        if (changed) {
          await ctx.audit({ event: "config_change", resourceType: RESOURCE, resourceId: "1", action: "settings.email.domain_status", details: { from: v.domainStatus, to: "not_started", reason: "removed in Resend" } });
        }
        return ok({ details: null, status: "not_started", changed, note: `Resend no longer has ${v.sendingDomain}. Add it again to send email.` });
      }
      throw new ActionError(found.error, { code: "blocked" });
    }
    const details = found.details;
    const changed = await mirrorDomain(current, { id: details.id, name: details.name, status: details.status });
    if (changed && details.status !== v.domainStatus) {
      await ctx.audit({
        event: "config_change",
        resourceType: RESOURCE,
        resourceId: "1",
        action: "settings.email.domain_status",
        details: { domain: details.name, from: v.domainStatus, to: details.status, resend_status: details.resendStatus, checked: input.verify ? "check now" : "poll" },
      });
    }
    return ok({ details, status: details.status, changed, note: null });
  },
);

// -------------------------------------------------------------------------------------------------
// Remove the domain (to start again)
// -------------------------------------------------------------------------------------------------

export const removeDomainSetup = defineAction(
  { name: "settings.email.domain_remove", schema: DomainRemoveSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<DomainActionResult>> => {
    needResend();
    const v = await view(ctx);
    if (!v.resendDomainId) return ok({ details: null, status: "not_started", changed: false, note: null });
    if (v.sendingDomain.toLowerCase() !== input.domain.trim().toLowerCase()) {
      throw new ActionError("The domain changed since this page loaded. Reload and try again.", { code: "conflict" });
    }
    const removed = await removeDomain(v.resendDomainId);
    if (!removed.ok) throw new ActionError(describeSendError(removed.error), { code: "blocked" });
    const changed = await mirrorDomain(
      { resendDomainId: v.resendDomainId, domainStatus: v.domainStatus, sendingDomain: v.sendingDomain, domainVerifiedAt: v.domainVerifiedAt },
      { id: null, name: v.sendingDomain, status: "not_started" },
    );
    await ctx.audit({
      event: "config_change",
      resourceType: RESOURCE,
      resourceId: "1",
      action: "settings.email.domain_remove",
      details: { domain: v.sendingDomain, resend_domain_id: v.resendDomainId, was: v.domainStatus },
    });
    return ok({ details: null, status: "not_started", changed, note: "Automatic email is off until a domain is verified again. Staff see WhatsApp and Gmail instead." });
  },
);

// -------------------------------------------------------------------------------------------------
// Sender: from-name, from-address, reply-to
// -------------------------------------------------------------------------------------------------

export const saveSenderSettings = defineAction(
  { name: "settings.email.sender_save", schema: SenderSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updated_at: string; changed: number }>> => {
    const { data: row, error } = await ctx.supabase
      .from("firm_settings")
      .select("email_from_name, email_from_address, email_reply_to, sending_domain, updated_at, updated_by")
      .eq("id", 1)
      .maybeSingle();
    throwIfDbError(error);
    if (!row) throw new ActionError("The firm's settings row is missing. Ask whoever set up the database to run the database seed.", { code: "not_found" });

    if (!fromAddressOnDomain(input.email_from_address, row.sending_domain)) {
      const msg = `The from address must end in @${row.sending_domain}, the domain verified in Resend.`;
      throw new ActionError(msg, { code: "validation", fieldErrors: { email_from_address: [msg] } });
    }

    // Concurrency on the three columns this form edits (§13). The domain status lives in the same
    // row and changes on its own when Resend reports, so the row's updated_at alone would refuse
    // saves nobody else touched.
    const theirs = { email_from_name: row.email_from_name, email_from_address: row.email_from_address, email_reply_to: row.email_reply_to };
    if (theirs.email_from_name !== input.was_from_name || theirs.email_from_address !== input.was_from_address || theirs.email_reply_to !== input.was_reply_to) {
      throw new ActionError(await whoChanged(ctx, row.updated_by, row.updated_at), { code: "conflict" });
    }
    const patch = { email_from_name: input.email_from_name, email_from_address: input.email_from_address.toLowerCase(), email_reply_to: input.email_reply_to.toLowerCase() };
    const changes = (Object.keys(patch) as Array<keyof typeof patch>)
      .filter((k) => patch[k] !== theirs[k])
      .map((k) => ({ field: k, before: theirs[k], after: patch[k] }));
    if (changes.length === 0) return ok({ updated_at: row.updated_at, changed: 0 });

    const { data: saved, error: upd } = await ctx.supabase
      .from("firm_settings")
      .update({ ...patch, updated_by: ctx.user.id })
      .eq("id", 1)
      .eq("email_from_name", input.was_from_name)
      .eq("email_from_address", input.was_from_address)
      .eq("email_reply_to", input.was_reply_to)
      .select("updated_at")
      .maybeSingle();
    throwIfDbError(upd);
    if (!saved) throw new ActionError(await whoChanged(ctx, row.updated_by, row.updated_at), { code: "conflict" });

    await ctx.audit({ event: "config_change", resourceType: RESOURCE, resourceId: "1", action: "settings.email.sender_save", details: { section: "email", changes } });
    return ok({ updated_at: saved.updated_at, changed: changes.length });
  },
);

async function whoChanged(ctx: ActionContext, by: string | null, at: string | null): Promise<string> {
  let name: string | null = null;
  try {
    if (by) name = (await getProfileNames(ctx.supabase, [by])).get(by) ?? null;
  } catch {
    name = null;
  }
  const when = at ? (formatDate(at) === formatDate(new Date()) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`) : "a moment ago";
  return `Changed by ${name ?? "someone else"} at ${when}. Reload to see their changes.`;
}

// -------------------------------------------------------------------------------------------------
// Test email (to yourself)
// -------------------------------------------------------------------------------------------------

export const sendTestEmail = defineAction(
  { name: "settings.email.test_send", schema: TestSendSchema, roles: ["partner"] },
  async (_input, ctx): Promise<ActionResult<{ status: "sent" | "not_configured" | "failed"; to: string; error: string | null }>> => {
    const v = await view(ctx);
    const to = ctx.user.email;
    if (!to) throw new ActionError("Your profile has no email address to send the test to.", { code: "blocked" });
    const firm = emailFirm(await getFirmProfile(ctx.supabase));
    const sentAt = new Date();
    const mail = testEmail({ recipientName: ctx.user.fullName, sentAt, from: v.sender, replyTo: v.replyTo, domain: emailDomainOf(v.fromAddress) ?? v.sendingDomain }, firm);
    const result = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html, kind: "test", idempotencyKey: `test:${ctx.user.id}:${sentAt.getTime()}` });
    await ctx.audit({
      event: "config_change",
      resourceType: RESOURCE,
      resourceId: "1",
      action: "settings.email.test_send",
      details: { to, status: result.status, delivery_id: result.deliveryId ?? null },
      success: result.status === "sent",
      error: result.status === "sent" ? undefined : result.error,
    });
    return ok({ status: result.status, to, error: result.error ?? null });
  },
);

