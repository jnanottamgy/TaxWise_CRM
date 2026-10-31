import "server-only";

import type { CurrentUser } from "@/lib/auth/current-user";
import { isManagerOrPartner } from "@/lib/auth/roles";
import type { ServerSupabase } from "@/lib/supabase/server";
import { generateTemporaryPassword } from "@/lib/auth/password-policy";
import { env } from "@/lib/env";
import { ActionError } from "@/lib/result";
import { log } from "@/lib/log";
import { firstNameOf, normalizeWhatsAppNumber, pickWhatsAppNumber } from "@/lib/domain/messaging";
import { createAdminClient } from "@/server/admin";
import { addTimelineEvent } from "@/server/timeline";

/**
 * Invites a client to the portal (§7.22 "Access"): creates an auth user with role `client` (in
 * app_metadata and profiles, with a temporary password that must be changed at first sign-in),
 * links it to the client **only** through `clients.portal_user_id` (never by matching email
 * addresses), and returns the login details once for the hand-out: the person shares them on
 * WhatsApp, like a staff login (§4.5). Nothing is emailed; the email address is only the sign-in name.
 *
 *   const invite = await inviteClientToPortal(ctx.supabase, ctx.user, clientId, { ip: ctx.ip, userAgent: ctx.userAgent });
 *
 * Shared by the onboarding wizard (after the client is created) and Client 360 → Overview → portal
 * access card. The caller must be a Partner or Manager; the link is written under the caller's
 * session (RLS agrees first), and the auth user is created with the service role (server/admin.ts),
 * then removed again if the link fails. Throws ActionError for known refusals (no email address to
 * sign in with, already invited, email used by another login).
 */

export type PortalInviteResult = {
  clientId: string;
  clientName: string;
  userId: string;
  email: string;
  /** Shown once; never logged or stored. */
  temporaryPassword: string;
  loginUrl: string;
  /** The WhatsApp hand-out of the login (§7.13.2). */
  handoff: {
    contactName: string;
    contactId: string | null;
    whatsappNumber: string | null;
    whatsappText: string;
  };
};

export async function inviteClientToPortal(
  supabase: ServerSupabase,
  user: CurrentUser,
  clientId: string,
  opts: { ip?: string | null; userAgent?: string | null } = {},
): Promise<PortalInviteResult> {
  if (!isManagerOrPartner(user.role)) {
    throw new ActionError("Only Partners and Managers can invite a client to the portal.", { code: "forbidden" });
  }

  const { data: client, error } = await supabase
    .from("clients")
    .select("id, display_name, email, phone, whatsapp, portal_user_id, deleted_at")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!client || client.deleted_at) throw new ActionError("That client isn't in the client list.", { code: "not_found" });
  if (client.portal_user_id) {
    throw new ActionError(`${client.display_name} already has portal access. Resend or revoke it from the client's Overview.`, { code: "conflict" });
  }

  const { data: contacts, error: cErr } = await supabase
    .from("client_contacts")
    .select("id, name, email, phone, whatsapp, is_primary")
    .eq("client_id", clientId)
    .order("is_primary", { ascending: false })
    .limit(5);
  if (cErr) throw cErr;
  const primary = contacts?.[0] ?? null;
  const email = (client.email ?? primary?.email ?? "").trim().toLowerCase();
  if (!email) throw new ActionError(`Add an email address for ${client.display_name} before inviting them to the portal.`, { code: "validation" });

  const admin = createAdminClient();
  const { count, error: dupErr } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("email", email);
  if (dupErr) throw dupErr;
  if ((count ?? 0) > 0) {
    throw new ActionError(
      `${email} already belongs to a TaxWise login. Use a different email address for this client's portal.`,
      { code: "conflict" },
    );
  }

  const contactName = primary?.name ?? client.display_name;
  const temporaryPassword = generateTemporaryPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    app_metadata: { role: "client", must_change_password: true },
    user_metadata: { full_name: contactName },
  });
  if (createErr || !created?.user) {
    if (createErr && (createErr.code === "email_exists" || /already (been )?registered|already exists/i.test(createErr.message ?? ""))) {
      throw new ActionError(`${email} already belongs to a TaxWise login. Use a different email address for this client's portal.`, { code: "conflict" });
    }
    throw Object.assign(new Error(`createUser failed: ${createErr?.message ?? "no user returned"}`), { code: createErr?.code });
  }
  const userId = created.user.id;

  const undo = async (what: string, err: unknown) => {
    log("error", `portal invite failed at ${what}; undoing`, { source: "portal-invite", userId: user.id, clientId, err });
    await admin.from("profiles").delete().eq("id", userId).then(
      () => undefined,
      () => undefined,
    );
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) log("error", "could not remove the half-created portal user", { source: "portal-invite", clientId, err: delErr });
  };

  const { error: profileErr } = await admin.from("profiles").insert({
    id: userId,
    full_name: contactName,
    email,
    phone: primary?.phone ?? client.phone ?? null,
    role: "client",
    must_change_password: true,
  });
  if (profileErr) {
    await undo("profile", profileErr);
    if (profileErr.code === "23505") throw new ActionError(`${email} already belongs to a TaxWise login.`, { code: "conflict" });
    throw Object.assign(new Error(`profile insert failed: ${profileErr.message}`), profileErr);
  }

  // The link is the only thing that connects a portal login to a client (§7.22), under the inviter's RLS.
  const { data: linked, error: linkErr } = await supabase
    .from("clients")
    .update({ portal_user_id: userId, portal_invited_at: new Date().toISOString() })
    .eq("id", clientId)
    .is("portal_user_id", null)
    .select("id");
  if (linkErr || !linked || linked.length === 0) {
    await undo("link", linkErr ?? new Error("client already linked"));
    if (!linkErr) throw new ActionError(`${client.display_name} was invited by someone else a moment ago. Reload to see it.`, { code: "conflict" });
    throw Object.assign(new Error(`portal link failed: ${linkErr.message}`), linkErr);
  }

  const { error: auditErr } = await supabase.rpc("log_audit_event", {
    p_event: "user_create",
    p_resource_type: "portal_user",
    p_resource_id: userId,
    p_action: "clients.portal_invite",
    p_details: { client_id: clientId, email },
    p_success: true,
    p_error: null,
    p_ip: opts.ip ?? null,
    p_user_agent: opts.userAgent ?? null,
  });
  if (auditErr) log("error", "portal invite audit write failed", { source: "portal-invite", userId: user.id, clientId, err: auditErr });
  await addTimelineEvent({ clientId, eventType: "portal_invited", title: `Invited to the client portal (${email})` });

  const loginUrl = `${env.appUrl().replace(/\/+$/, "")}/login`;
  const pick = pickWhatsAppNumber(primary, client);
  const whatsappText = [
    `Hi ${firstNameOf(contactName) || contactName}, we've set up your client portal for ${client.display_name}.`,
    `Sign in at ${loginUrl}`,
    `Email: ${email}`,
    `Temporary password: ${temporaryPassword}`,
    "You'll choose your own password the first time you sign in. Never share it with anyone; we will never ask you for it.",
  ].join("\n");
  return {
    clientId,
    clientName: client.display_name,
    userId,
    email,
    temporaryPassword,
    loginUrl,
    handoff: {
      contactName,
      contactId: primary?.id ?? null,
      whatsappNumber: pick?.digits ?? (client.whatsapp ? normalizeWhatsAppNumber(client.whatsapp) : null),
      whatsappText,
    },
  };
}
