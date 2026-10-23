import "server-only";

import type { AuthError } from "@supabase/supabase-js";
import { createAdminClient } from "@/server/admin";
import { generateTemporaryPassword } from "@/lib/auth/password-policy";
import { ActionError } from "@/lib/result";
import { log } from "@/lib/log";
import type { StaffRole } from "@/lib/schemas/people";

/**
 * The Auth side of the staff lifecycle (§4.5), with the service role (server/admin.ts). Every
 * caller is a defineAction handler that has already checked the actor's role against the person's,
 * and read the person's record under the actor's own session (so RLS agreed first).
 *
 *   createStaffLogin     §4.5 point 2: the auth user (app_metadata.role, must_change_password), the
 *                        profiles row and the link from the employees row, undone if a step fails.
 *   resetStaffPassword   §4.5 point 3: a new temporary password, forced change, sessions ended.
 *   moveAuthEmail        §4.5 point 4: the auth account's email moves first (email_confirm).
 *   writeAppRole         §4.5 point 5: the JWT hint follows profiles.role.
 *   endAllSessions       role change, password reset: the change takes effect at once.
 *   setLoginBanned       §4.5 point 6: sign-in blocked immediately (and sessions revoked).
 *   resetTwoStep         Partner: removes the person's authenticator factors.
 *
 * Nothing here ever writes a role into user_metadata (§0.1 rule 9, §4.4).
 */

export interface IssuedLogin {
  userId: string;
  email: string;
  /** Shown once in the "Login created" dialog; never logged or stored. */
  temporaryPassword: string;
}

function isEmailTaken(error: AuthError | null | undefined): boolean {
  if (!error) return false;
  return error.code === "email_exists" || error.code === "user_already_exists" || /already (been )?registered|already exists/i.test(error.message ?? "");
}

/** True when another profile (staff or portal) already uses this email. */
export async function emailHasLogin(email: string, exceptProfileId: string | null = null): Promise<boolean> {
  const admin = createAdminClient();
  let q = admin.from("profiles").select("id", { count: "exact", head: true }).eq("email", email);
  if (exceptProfileId) q = q.neq("id", exceptProfileId);
  const { count, error } = await q;
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Which of these emails already belong to a login (staff or portal), lower-cased. */
export async function emailsWithLogin(emails: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (emails.length === 0) return out;
  const admin = createAdminClient();
  for (let i = 0; i < emails.length; i += 200) {
    const { data, error } = await admin.from("profiles").select("email").in("email", emails.slice(i, i + 200) as string[]);
    if (error) throw error;
    for (const r of data ?? []) out.add(String(r.email).toLowerCase());
  }
  return out;
}

/**
 * Creates the login for an employees row that has none (§4.5 point 2): the auth user with a
 * temporary password that meets the policy, `app_metadata = { role, must_change_password: true }`,
 * the profiles row (the role's authority), and `employees.profile_id`. If any step fails, the
 * steps before it are undone, so a person never ends up with half a login.
 */
export async function createStaffLogin(p: {
  employeeId: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: StaffRole;
  icaiMembershipNo?: string | null;
}): Promise<IssuedLogin> {
  const admin = createAdminClient();
  if (await emailHasLogin(p.email)) {
    throw new ActionError("A login already exists for this email address.", { code: "conflict", fieldErrors: { email: ["A login already exists for this email address."] } });
  }

  const temporaryPassword = generateTemporaryPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email: p.email,
    password: temporaryPassword,
    email_confirm: true,
    app_metadata: { role: p.role, must_change_password: true },
    user_metadata: { full_name: p.fullName },
  });
  if (error || !data?.user) {
    if (isEmailTaken(error)) {
      throw new ActionError("A login already exists for this email address.", { code: "conflict", fieldErrors: { email: ["A login already exists for this email address."] } });
    }
    throw Object.assign(new Error(`createUser failed: ${error?.message ?? "no user returned"}`), { code: error?.code });
  }
  const userId = data.user.id;

  const undo = async (what: string, err: unknown) => {
    log("error", `login creation failed at ${what}; undoing`, { source: "people-admin:createStaffLogin", err });
    await admin.from("profiles").delete().eq("id", userId).then(
      () => undefined,
      () => undefined,
    );
    const { error: delError } = await admin.auth.admin.deleteUser(userId);
    if (delError) log("error", "could not remove the half-created auth user", { source: "people-admin:createStaffLogin", err: delError });
  };

  const { error: profileError } = await admin.from("profiles").insert({
    id: userId,
    full_name: p.fullName,
    email: p.email,
    phone: p.phone,
    role: p.role,
    must_change_password: true,
    icai_membership_no: p.role === "partner" ? (p.icaiMembershipNo ?? null) : null,
  });
  if (profileError) {
    await undo("profile", profileError);
    if (profileError.code === "23505") {
      throw new ActionError("A login already exists for this email address.", { code: "conflict", fieldErrors: { email: ["A login already exists for this email address."] } });
    }
    throw Object.assign(new Error(`profile insert failed: ${profileError.message}`), profileError);
  }

  const { data: linked, error: linkError } = await admin
    .from("employees")
    .update({ profile_id: userId })
    .eq("id", p.employeeId)
    .is("profile_id", null)
    .select("id");
  if (linkError || !linked || linked.length === 0) {
    await undo("link", linkError ?? new Error("employee already linked"));
    if (!linkError) throw new ActionError("This person already has a login. Reload to see it.", { code: "conflict" });
    throw Object.assign(new Error(`employee link failed: ${linkError.message}`), linkError);
  }

  return { userId, email: p.email, temporaryPassword };
}

/** Removes a login created moments ago (the action failed after creating it). */
export async function removeLogin(userId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("employees").update({ profile_id: null }).eq("profile_id", userId);
  await admin.from("profiles").delete().eq("id", userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw error;
}

/** Ends every session of a login (refresh tokens revoked), so a change takes effect at once. */
export async function endAllSessions(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("revoke_auth_sessions", { p_user: userId });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/**
 * §4.5 point 3: a new temporary password, marked must-change in app_metadata and on the profile,
 * and every session ended. Returns the password to show once.
 */
export async function resetStaffPassword(userId: string, role: StaffRole): Promise<string> {
  const admin = createAdminClient();
  const temporaryPassword = generateTemporaryPassword();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: temporaryPassword,
    app_metadata: { role, must_change_password: true },
  });
  if (error) throw Object.assign(new Error(`password reset failed: ${error.message}`), { code: error.code });
  const { error: profileError } = await admin.from("profiles").update({ must_change_password: true }).eq("id", userId);
  if (profileError) throw profileError;
  try {
    await endAllSessions(userId);
  } catch (err) {
    // The forced-change gate already refuses every action until they set a password (§4.4).
    log("warn", "sessions not ended after a password reset", { source: "people-admin:resetStaffPassword", userId, err });
  }
  return temporaryPassword;
}

/**
 * §4.5 point 4: moves the auth account's email (confirmed, so no confirmation mail is needed).
 * Refused addresses come back as a field error and nothing has changed.
 */
export async function moveAuthEmail(userId: string, email: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { email, email_confirm: true });
  if (!error) return;
  if (isEmailTaken(error)) {
    throw new ActionError("Someone already uses that email address.", { code: "conflict", fieldErrors: { email: ["Someone already uses that email address."] } });
  }
  if (error.status === 400 || error.status === 422) {
    throw new ActionError("Supabase refused that address. Check it and try again.", { fieldErrors: { email: ["Supabase refused that address. Check it and try again."] } });
  }
  throw Object.assign(new Error(`email change failed: ${error.message}`), { code: error.code });
}

/** §4.5 point 5: the JWT's app_metadata.role follows profiles.role. */
export async function writeAppRole(userId: string, role: StaffRole): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { role } });
  if (error) throw Object.assign(new Error(`app_metadata write failed: ${error.message}`), { code: error.code });
}

/** §4.5 point 6: a ban blocks sign-in at once and revokes the sessions; "none" lifts it. */
export async function setLoginBanned(userId: string, banned: boolean): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: banned ? "876000h" : "none" });
  if (error) throw Object.assign(new Error(`ban update failed: ${error.message}`), { code: error.code });
  if (banned) {
    try {
      await endAllSessions(userId);
    } catch (err) {
      log("warn", "sessions not ended after a ban", { source: "people-admin:setLoginBanned", userId, err });
    }
  }
}

/** Partner: removes every authenticator factor of a login (they enrol again at next sign-in). */
export async function resetTwoStep(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw Object.assign(new Error(`factor list failed: ${error.message}`), { code: error.code });
  let removed = 0;
  for (const factor of data?.factors ?? []) {
    const { error: delError } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
    if (delError) throw Object.assign(new Error(`factor delete failed: ${delError.message}`), { code: delError.code });
    removed += 1;
  }
  try {
    await endAllSessions(userId);
  } catch (err) {
    log("warn", "sessions not ended after a two-step reset", { source: "people-admin:resetTwoStep", userId, err });
  }
  return removed;
}

/** Removes an employees row created moments ago, when issuing its login failed (§4.5 point 2). */
export async function discardNewEmployee(employeeId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("employees").delete().eq("id", employeeId).is("profile_id", null);
  if (error) throw error;
}
