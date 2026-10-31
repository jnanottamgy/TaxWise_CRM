"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { env } from "@/lib/env";
import { log, logUnexpected } from "@/lib/log";
import { generateTemporaryPassword } from "@/lib/auth/password-policy";
import { firstNameOf, normalizeWhatsAppNumber, pickWhatsAppNumber } from "@/lib/domain/messaging";
import { PortalAccessSchema, RevokePortalSchema } from "@/components/client360/logic/profile-schemas";
import { createAdminClient } from "@/server/admin";
import { endAllSessions, setLoginBanned } from "@/server/people-admin";
import { inviteClientToPortal, type PortalInviteResult } from "@/server/portal-invite";
import { addTimelineEvent } from "@/server/timeline";

/**
 * Client 360 → Overview → Portal access (§7.22 "Access"), Partner/Manager only:
 *
 *   invitePortal         a new portal login (server/portal-invite.ts inviteClientToPortal: an auth user
 *                        with role client, linked ONLY through clients.portal_user_id), or, for a
 *                        client whose access was revoked, the same login restored: unbanned, a new
 *                        temporary password, linked again;
 *   resendPortalInvite   a new temporary password (must be changed at first sign-in), sessions ended:
 *                        how a client who forgot their password gets back in;
 *   revokePortalAccess   unlinks the login first (that alone ends what it can see, RLS), then bans it,
 *                        deactivates its profile and ends its sessions (server/admin.ts).
 *
 * Each returns the login details once for the hand-out (Share on WhatsApp, §7.13.2) where relevant,
 * and writes an audit row (user_create / user_update / user_disable) and a timeline entry. Nothing
 * is emailed.
 */

const MANAGERS = ["partner", "manager"] as const;

export interface PortalHandout {
  kind: "invite" | "restore" | "resend";
  clientId: string;
  clientName: string;
  email: string;
  /** Shown once; never logged or stored. */
  temporaryPassword: string;
  loginUrl: string;
  handoff: PortalInviteResult["handoff"];
}

function loginUrl(): string {
  return `${env.appUrl().replace(/\/+$/, "")}/login`;
}

async function conflictMessage(ctx: ActionContext, clientId: string): Promise<string> {
  const { data } = await ctx.supabase.rpc("client_change_conflict", { p_client_id: clientId });
  return typeof data === "string" && data ? data.replace(/^USER:\s*/, "") : "This client was changed by someone else. Reload to see their changes.";
}

async function loadClient(ctx: ActionContext, clientId: string) {
  const { data, error } = await ctx.supabase
    .from("clients")
    .select("id, display_name, email, phone, whatsapp, owner_employee_id, portal_user_id, portal_invited_at, portal_last_seen_at, portal_revoked_user_id, updated_at, deleted_at")
    .eq("id", clientId)
    .maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
  return data;
}

type ClientRow = Awaited<ReturnType<typeof loadClient>>;

async function primaryContact(ctx: ActionContext, clientId: string) {
  const { data, error } = await ctx.supabase
    .from("client_contacts")
    .select("id, name, email, phone, whatsapp, is_primary")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  throwIfDbError(error);
  return (data ?? [])[0] ?? null;
}

/** The WhatsApp hand-out of a login (§7.13.2), worded like the invite's. */
function handoffFor(client: ClientRow, contact: Awaited<ReturnType<typeof primaryContact>>, email: string, password: string, kind: PortalHandout["kind"]): PortalHandout["handoff"] {
  const contactName = contact?.name ?? client.display_name;
  const first = firstNameOf(contactName) || contactName;
  const opening =
    kind === "resend"
      ? `Hi ${first}, here is a new temporary password for your client portal for ${client.display_name}.`
      : `Hi ${first}, we've set up your client portal for ${client.display_name}.`;
  const whatsappText = [
    opening,
    `Sign in at ${loginUrl()}`,
    `Email: ${email}`,
    `Temporary password: ${password}`,
    "You'll choose your own password the first time you sign in. Never share it with anyone; we will never ask you for it.",
  ].join("\n");
  const pick = pickWhatsAppNumber(contact, client);
  return {
    contactName,
    contactId: contact?.id ?? null,
    whatsappNumber: pick?.digits ?? (client.whatsapp ? normalizeWhatsAppNumber(client.whatsapp) : null),
    whatsappText,
  };
}

/** A portal login's profile (service role): it must be a client login. */
async function portalProfile(userId: string): Promise<{ id: string; email: string; full_name: string } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("profiles").select("id, email, full_name, role").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!data || data.role !== "client") return null;
  return { id: data.id, email: String(data.email), full_name: data.full_name };
}

/** A new temporary password for a portal login, must-change set in app_metadata and on the profile. */
async function issueTemporaryPassword(userId: string, opts: { unban: boolean }): Promise<string> {
  const admin = createAdminClient();
  const temporaryPassword = generateTemporaryPassword();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: temporaryPassword,
    app_metadata: { role: "client", must_change_password: true },
    ...(opts.unban ? { ban_duration: "none" } : {}),
  });
  if (error) throw Object.assign(new Error(`portal password reset failed: ${error.message}`), { code: error.code });
  const { error: profileError } = await admin.from("profiles").update({ must_change_password: true, ...(opts.unban ? { is_active: true } : {}) }).eq("id", userId);
  if (profileError) throw profileError;
  return temporaryPassword;
}

export const invitePortal = defineAction(
  { name: "clients.portal_invite", schema: PortalAccessSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<PortalHandout>> => {
    const client = await loadClient(ctx, input.clientId);
    if (client.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });
    if (client.portal_user_id) return fail(`${client.display_name} already has portal access. Resend the invite or revoke it instead.`, { code: "conflict" });

    // A revoked client gets its own login back (the ban is lifted), never a second login.
    if (client.portal_revoked_user_id) {
      const profile = await portalProfile(client.portal_revoked_user_id);
      if (profile) {
        const contact = await primaryContact(ctx, client.id);
        const password = await issueTemporaryPassword(profile.id, { unban: true });
        const { data: linked, error: linkError } = await ctx.supabase
          .from("clients")
          .update({ portal_user_id: profile.id, portal_invited_at: new Date().toISOString() })
          .eq("id", client.id)
          .is("portal_user_id", null)
          .eq("updated_at", input.updatedAt)
          .select("id");
        if (linkError || !linked || linked.length === 0) {
          // Put the ban back: the login stays closed unless it is linked.
          await setLoginBanned(profile.id, true).catch((err) => log("error", "could not re-ban a portal login after a failed restore", { source: "action:clients.portal_invite", clientId: client.id, err }));
          await createAdminClient().from("profiles").update({ is_active: false }).eq("id", profile.id);
          throwIfDbError(linkError);
          return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });
        }
        await ctx.audit({ event: "user_update", resourceType: "portal_user", resourceId: profile.id, action: "clients.portal_restore", details: { client_id: client.id, email: profile.email } });
        ctx.after("Add the portal restore to the client's timeline", () =>
          addTimelineEvent({ clientId: client.id, eventType: "portal_restored", title: `Portal access restored (${profile.email})` }),
        );
        return ok({
          kind: "restore",
          clientId: client.id,
          clientName: client.display_name,
          email: profile.email,
          temporaryPassword: password,
          loginUrl: loginUrl(),
          handoff: handoffFor(client, contact, profile.email, password, "restore"),
        });
      }
    }

    const r = await inviteClientToPortal(ctx.supabase, ctx.user, client.id, { ip: ctx.ip, userAgent: ctx.userAgent });
    return ok({
      kind: "invite",
      clientId: r.clientId,
      clientName: r.clientName,
      email: r.email,
      temporaryPassword: r.temporaryPassword,
      loginUrl: r.loginUrl,
      handoff: r.handoff,
    });
  },
);

export const resendPortalInvite = defineAction(
  { name: "clients.portal_resend", schema: PortalAccessSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<PortalHandout>> => {
    const client = await loadClient(ctx, input.clientId);
    if (client.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });
    if (!client.portal_user_id) return fail(`${client.display_name} has no portal login yet. Invite them first.`, { code: "blocked" });

    const profile = await portalProfile(client.portal_user_id);
    if (!profile) return fail("This client's portal login can't be found. Revoke it and invite them again.", { code: "blocked" });
    const contact = await primaryContact(ctx, client.id);
    const password = await issueTemporaryPassword(profile.id, { unban: false });
    try {
      await endAllSessions(profile.id);
    } catch (err) {
      // The forced password change refuses everything until they set one (§4.4).
      log("warn", "portal sessions not ended after a resend", { source: "action:clients.portal_resend", clientId: client.id, err });
    }

    // The new password is already set: a failed stamp must not hide it from the person (§0.1 rule 5).
    const { error: stampError } = await ctx.supabase.from("clients").update({ portal_invited_at: new Date().toISOString() }).eq("id", client.id).eq("portal_user_id", profile.id);
    if (stampError) log("warn", "portal_invited_at not stamped after a resend", { source: "action:clients.portal_resend", userId: ctx.user.id, clientId: client.id, err: stampError });

    const neverSignedIn = !client.portal_last_seen_at;
    await ctx.audit({ event: "user_update", resourceType: "portal_user", resourceId: profile.id, action: "clients.portal_resend", details: { client_id: client.id, never_signed_in: neverSignedIn } });
    ctx.after("Add the resend to the client's timeline", () =>
      addTimelineEvent({
        clientId: client.id,
        eventType: neverSignedIn ? "portal_invite_resent" : "portal_password_reset",
        title: neverSignedIn ? `Portal invite sent again (${profile.email})` : `Portal password reset (${profile.email})`,
      }),
    );
    return ok({
      kind: "resend",
      clientId: client.id,
      clientName: client.display_name,
      email: profile.email,
      temporaryPassword: password,
      loginUrl: loginUrl(),
      handoff: handoffFor(client, contact, profile.email, password, "resend"),
    });
  },
);

export const revokePortalAccess = defineAction(
  { name: "clients.portal_revoke", schema: RevokePortalSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ revoked: boolean }>> => {
    const client = await loadClient(ctx, input.clientId);
    if (client.updated_at !== input.updatedAt) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });
    if (!client.portal_user_id) return ok({ revoked: false });
    const userId = client.portal_user_id;

    // 1. Unlink (under the caller's RLS): from this moment the login sees nothing (§7.22).
    const { data, error } = await ctx.supabase
      .from("clients")
      .update({ portal_user_id: null, portal_revoked_at: new Date().toISOString(), portal_revoked_by: ctx.user.id, portal_revoked_user_id: userId })
      .eq("id", client.id)
      .eq("portal_user_id", userId)
      .eq("updated_at", input.updatedAt)
      .select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail(await conflictMessage(ctx, input.clientId), { code: "conflict" });

    // 2. Ban, deactivate and sign out (service role). A failure here can't reopen access: the link is gone.
    const warnings: string[] = [];
    try {
      await setLoginBanned(userId, true);
      const { error: profileError } = await createAdminClient().from("profiles").update({ is_active: false }).eq("id", userId).eq("role", "client");
      if (profileError) throw profileError;
    } catch (err) {
      const ref = logUnexpected(err, { source: "action:clients.portal_revoke:ban", userId: ctx.user.id, role: ctx.user.role, clientId: client.id });
      warnings.push(`Portal access is removed, but the login couldn't be blocked from signing in. Ask a Partner to check Diagnostics. (Ref ${ref})`);
    }

    await ctx.audit({ event: "user_disable", resourceType: "portal_user", resourceId: userId, action: "clients.portal_revoke", details: { client_id: client.id, reason: input.reason } });
    ctx.after("Add the revoke to the client's timeline", () =>
      addTimelineEvent({ clientId: client.id, eventType: "portal_revoked", title: "Portal access revoked", description: input.reason }),
    );
    return ok({ revoked: true }, warnings);
  },
);
