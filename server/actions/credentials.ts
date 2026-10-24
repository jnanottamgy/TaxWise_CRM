"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { logUnexpected } from "@/lib/log";
import { RATE_LIMITS, checkRateLimit } from "@/lib/rate-limit";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { createAdminClient } from "@/server/admin";
import { decryptSecret, encryptSecret, VaultError } from "@/server/vault";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";
import { getCredentialTrail, type TrailRow } from "@/lib/data/registers";
import {
  CreateCredentialSchema,
  IdSchema,
  RecordRefSchema,
  REVEAL_SECONDS,
  UpdateCredentialSchema,
  credentialContext,
  portalName,
} from "@/lib/schemas/registers";

/**
 * The portal credentials vault (§7.15.1, §4.1, §4.6, §4.7, §12, §18.3 Partner 8).
 *
 *   createCredential / updateCredential   Partners and Managers. The password is sealed here with
 *                                          server/vault.ts (AES-256-GCM, bound to the client) and
 *                                          stored through save_client_credential (0033), which logs
 *                                          "created" / "updated". It never comes back to a list.
 *   deleteCredential                       Partners and Managers (delete_client_credential).
 *   revealCredential                       any staff member the database allows: Partners, Managers,
 *                                          Employees with Vault access for their own clients, and
 *                                          covered clients only when the cover includes portal
 *                                          passwords (credential_reveal_check, 0191). The ciphertext
 *                                          is read with the service role only after that check,
 *                                          decrypted in memory, and the password is returned only
 *                                          once record_credential_reveal has written the access log
 *                                          (who, when, IP) and the credential_viewed audit row. The
 *                                          screen shows it for 30 seconds. At most
 *                                          RATE_LIMITS.credentialReveal per person (§13).
 *   logCredentialCopy                      "copied" in the access trail.
 *   loadCredentialTrail                    the access trail (Partners and Managers).
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This login was changed by someone else. Reload to see their changes.";

function sealFor(clientId: string, password: string): string {
  try {
    return encryptSecret(password, { context: credentialContext(clientId) });
  } catch (err) {
    if (err instanceof VaultError && (err.code === "missing_key" || err.code === "invalid_key")) {
      throw new ActionError("The password vault isn't set up on the server (CREDENTIAL_VAULT_KEY), so nothing was stored. A Partner can check Settings → Diagnostics.", { code: "blocked" });
    }
    throw err;
  }
}

async function clientOf(ctx: ActionContext, clientId: string): Promise<{ id: string; display_name: string }> {
  const { data, error } = await ctx.supabase.from("clients").select("id, display_name, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  if (!data || data.deleted_at) throw new ActionError("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
  return { id: data.id, display_name: data.display_name };
}

type Listed = { id: string; client_id: string; client_name: string; portal: string; portal_label: string | null; username: string; updated_at: string };

async function listed(ctx: ActionContext, id: string): Promise<Listed> {
  const { data, error } = await ctx.supabase
    .from("client_credentials_register")
    .select("id, client_id, client_name, portal, portal_label, username, updated_at")
    .eq("id", id)
    .maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That stored login no longer exists, or it isn't for one of your clients.", { code: "not_found" });
  return data as Listed;
}

function throwSaveError(error: { code?: string; message?: string } | null): void {
  if (error?.message?.includes("changed by someone else")) throw new ActionError(STALE, { code: "conflict" });
  throwIfDbError(error, { uniqueField: "username", uniqueMessage: "This client already has a stored login with that username for this portal." });
}

export const createCredential = defineAction(
  { name: "credentials.create", schema: CreateCredentialSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const client = await clientOf(ctx, input.clientId);
    const sealed = sealFor(client.id, input.password);
    const { data, error } = await ctx.supabase.rpc("save_client_credential", {
      p_id: null,
      p_client_id: client.id,
      p_portal: input.portal,
      p_portal_label: input.portal === "OTHER" ? input.portalLabel : null,
      p_username: input.username,
      p_password_ciphertext: sealed,
      p_login_url: input.loginUrl,
      p_notes: input.notes,
    });
    throwSaveError(error);
    const id = data as string;
    const name = portalName(input.portal, input.portalLabel);
    await ctx.audit({ event: "data_create", resourceType: "client_credential", resourceId: id, details: { client_id: client.id, portal: input.portal, portal_label: input.portalLabel, username: input.username } });
    ctx.after("Add the login to the client's timeline", () =>
      addTimelineEvent({ clientId: client.id, eventType: "credential_added", title: `${name} login stored in the vault (${input.username})`, metadata: { credential_id: id, portal: input.portal } }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "client_updated", description: `Stored the ${name} login of ${client.display_name}`, entityType: "client", entityId: client.id, entityName: client.display_name }),
    );
    return ok({ id });
  },
);

export const updateCredential = defineAction(
  { name: "credentials.update", schema: UpdateCredentialSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; passwordChanged: boolean }>> => {
    const before = await listed(ctx, input.id);
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const sealed = input.password ? sealFor(before.client_id, input.password) : null;
    const { error } = await ctx.supabase.rpc("save_client_credential", {
      p_id: input.id,
      // The client never changes: a sealed password is bound to it.
      p_client_id: before.client_id,
      p_portal: input.portal,
      p_portal_label: input.portal === "OTHER" ? input.portalLabel : null,
      p_username: input.username,
      p_password_ciphertext: sealed,
      p_login_url: input.loginUrl,
      p_notes: input.notes,
      p_expected_updated_at: input.updatedAt,
    });
    throwSaveError(error);
    const changed: string[] = [];
    if (before.portal !== input.portal || (before.portal_label ?? null) !== (input.portal === "OTHER" ? input.portalLabel : null)) changed.push("portal");
    if (before.username !== input.username) changed.push("username");
    if (sealed) changed.push("password");
    await ctx.audit({ event: "data_update", resourceType: "client_credential", resourceId: input.id, details: { client_id: before.client_id, changed } });
    if (changed.length) {
      ctx.after("Add the change to the client's timeline", () =>
        addTimelineEvent({
          clientId: before.client_id,
          eventType: "credential_updated",
          title: `${portalName(input.portal, input.portalLabel)} login changed (${changed.join(", ")})`,
          metadata: { credential_id: input.id, changed },
        }),
      );
    }
    return ok({ id: input.id, passwordChanged: Boolean(sealed) });
  },
);

export const deleteCredential = defineAction(
  { name: "credentials.delete", schema: RecordRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const before = await listed(ctx, input.id);
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const { data, error } = await ctx.supabase.rpc("delete_client_credential", { p_id: input.id });
    throwIfDbError(error);
    if (!data) return fail("That stored login has already been deleted.", { code: "not_found" });
    const name = portalName(before.portal, before.portal_label);
    await ctx.audit({ event: "data_delete", resourceType: "client_credential", resourceId: input.id, details: { client_id: before.client_id, portal: before.portal, username: before.username } });
    ctx.after("Add the removal to the client's timeline", () =>
      addTimelineEvent({ clientId: before.client_id, eventType: "credential_removed", title: `${name} login removed from the vault (${before.username})`, metadata: { credential_id: input.id } }),
    );
    return ok({ id: input.id });
  },
);

export type Revealed = { password: string; visibleForSeconds: number; loggedAt: string };

export const revealCredential = defineAction(
  { name: "credentials.reveal", schema: IdSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<Revealed>> => {
    // 1. May this person see it? (Under their own session: the database decides.)
    const { data: check, error: checkError } = await ctx.supabase.rpc("credential_reveal_check", { p_credential_id: input.id });
    throwIfDbError(checkError);
    const c = (check ?? {}) as { allowed?: boolean; reason?: string | null; client_id?: string | null };
    if (!c.allowed || !c.client_id) {
      await ctx.audit({ event: "access_denied", resourceType: "client_credential", resourceId: input.id, action: "credentials.reveal", success: false, error: c.reason ?? "not allowed" });
      return fail(c.reason ?? "You can't reveal this stored password.", { code: "forbidden" });
    }

    // 2. No more than RATE_LIMITS.credentialReveal per person (§13); exceeding it is audited.
    const limit = await checkRateLimit({
      scope: "credential_reveal",
      identity: [ctx.user.id],
      ...RATE_LIMITS.credentialReveal,
      audit: { userId: ctx.user.id, email: ctx.user.email, ip: ctx.ip, userAgent: ctx.userAgent },
    });
    if (!limit.allowed) {
      return fail(`You've revealed ${RATE_LIMITS.credentialReveal.limit} stored passwords in the last ${RATE_LIMITS.credentialReveal.windowSeconds / 60} minutes. Wait a few minutes, then try again.`, { code: "rate_limited" });
    }

    // 3. Open it in memory. The service role is the only reader of the ciphertext (§4.6, §12).
    const admin = createAdminClient();
    const { data: row, error: readError } = await admin.from("client_credentials").select("client_id, password_ciphertext").eq("id", input.id).maybeSingle();
    if (readError) throw readError;
    if (!row || row.client_id !== c.client_id) return fail("That stored login no longer exists.", { code: "not_found" });
    let password: string;
    try {
      password = decryptSecret(row.password_ciphertext, { context: credentialContext(row.client_id) });
    } catch (err) {
      const ref = logUnexpected(err, { source: "action:credentials.reveal:decrypt", userId: ctx.user.id, role: ctx.user.role, credentialId: input.id });
      await ctx.audit({ event: "credential_viewed", resourceType: "client_credential", resourceId: input.id, action: "credentials.reveal", success: false, error: err instanceof VaultError ? err.code : "decrypt failed" });
      const message =
        err instanceof VaultError && (err.code === "missing_key" || err.code === "invalid_key")
          ? "The password vault isn't set up on the server (CREDENTIAL_VAULT_KEY). A Partner can check Settings → Diagnostics."
          : err instanceof VaultError && err.code === "unknown_version"
            ? "This password was stored with an older vault key that this server doesn't have. A Partner needs to add it before it can be read."
            : "This stored password can't be opened. Store it again from the portal's own records.";
      return fail(message, { code: "blocked", ref });
    }

    // 4. Log it (access trail with the IP + audit row), or show nothing.
    const { data: rec, error: recError } = await ctx.supabase.rpc("record_credential_reveal", { p_credential_id: input.id, p_ip: ctx.ip, p_user_agent: ctx.userAgent });
    throwIfDbError(recError);
    const loggedAt = ((rec ?? {}) as { logged_at?: string }).logged_at ?? new Date().toISOString();
    return ok({ password, visibleForSeconds: REVEAL_SECONDS, loggedAt });
  },
);

export const logCredentialCopy = defineAction(
  { name: "credentials.copy", schema: IdSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ logged: true }>> => {
    const { error } = await ctx.supabase.from("credential_access_logs").insert({ credential_id: input.id, user_id: ctx.user.id, action: "copied", ip: ctx.ip });
    throwIfDbError(error);
    return ok({ logged: true });
  },
);

export const loadCredentialTrail = defineAction(
  { name: "credentials.trail", schema: z.object({ id: z.uuid() }), roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<TrailRow[]>> => ok(await getCredentialTrail(ctx.supabase, input.id)),
);
