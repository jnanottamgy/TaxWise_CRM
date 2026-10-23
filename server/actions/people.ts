"use server";

import { z } from "zod";
import type { TablesUpdate } from "@/lib/database.types";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import {
  AddPersonSchema,
  ChangeEmailSchema,
  ChangeRoleSchema,
  DeletePersonSchema,
  ImportPeopleSchema,
  IssueLoginsSchema,
  PersonRefSchema,
  ReassignWorkSchema,
  SetActiveSchema,
  UpdatePersonSchema,
  assignableRoles,
  canManagePerson,
  checkImportRows,
  loginInviteEmail,
  manageRefusal,
  type LoginStatus,
  type StaffRole,
} from "@/lib/schemas/people";
import {
  createStaffLogin,
  discardNewEmployee,
  emailHasLogin,
  emailsWithLogin,
  endAllSessions,
  moveAuthEmail,
  resetStaffPassword,
  resetTwoStep,
  setLoginBanned,
  writeAppRole,
} from "@/server/people-admin";
import { sendEmail } from "@/server/email/send";
import { notify } from "@/server/notify";
import { logActivity } from "@/server/activity";

/**
 * The staff lifecycle (§4.5, all eight points; §4.1 "Managers can't touch Partners/Managers").
 * Every action checks the actor against the person's role here, writes under the actor's session
 * where RLS can decide (employees, profiles, the 0105 functions), and uses the service role only
 * for the Auth side (server/people-admin.ts). Temporary passwords are returned once for the
 * "Login created" dialog and never logged, audited or stored.
 */

const MANAGERS = ["partner", "manager"] as const;

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && Date.parse(a) === Date.parse(b);

interface ManagedPerson {
  id: string;
  profile_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  whatsapp: string | null;
  role: StaffRole;
  login_status: LoginStatus;
  updated_at: string;
}

/** The person as the actor's RLS shows them, refused unless the actor may manage their role. */
async function loadManaged(ctx: ActionContext, id: string, action: string): Promise<ManagedPerson> {
  const { data, error } = await ctx.supabase
    .from("people_overview")
    .select("id, profile_id, full_name, email, phone, whatsapp, role, login_status, updated_at")
    .eq("id", id)
    .maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That person wasn't found. They may have been deleted.", { code: "not_found" });
  const person: ManagedPerson = {
    id: data.id as string,
    profile_id: data.profile_id,
    full_name: data.full_name ?? "",
    email: data.email ?? "",
    phone: data.phone,
    whatsapp: data.whatsapp,
    role: (data.role ?? "employee") as StaffRole,
    login_status: (data.login_status ?? "no_login") as LoginStatus,
    updated_at: data.updated_at ?? "",
  };
  if (!canManagePerson(ctx.user.role, person.role)) {
    await ctx.audit({ event: "access_denied", resourceType: "employee", resourceId: id, action, success: false, details: { subject_role: person.role } });
    throw new ActionError(manageRefusal(ctx.user.role), { code: "forbidden" });
  }
  return person;
}

async function firmName(ctx: ActionContext): Promise<string> {
  const { data } = await ctx.supabase.from("firm_settings").select("firm_name").eq("id", 1).maybeSingle();
  return data?.firm_name || "TaxWise Consultants";
}

function loginUrl(): string {
  return `${env.appUrl().replace(/\/$/, "")}/login`;
}

export interface InviteOutcome {
  status: "sent" | "not_configured" | "failed";
  /** The provider's reason when it didn't go (§4.5 point 2). */
  error?: string;
}

/** What the "Login created" dialog shows (§4.5 point 2). The password is shown once. */
export interface LoginHandout {
  employeeId: string;
  fullName: string;
  email: string;
  temporaryPassword: string;
  /** Normalised WhatsApp digits for Share on WhatsApp, or null. */
  whatsapp: string | null;
  loginUrl: string;
  firmName: string;
  invite: InviteOutcome;
  kind: "invite" | "reset";
}

async function emailLogin(
  ctx: ActionContext,
  p: { employeeId: string; userId: string; fullName: string; email: string; password: string; firm: string; kind: "invite" | "reset" },
): Promise<InviteOutcome> {
  const { subject, text } = loginInviteEmail(
    { fullName: p.fullName, email: p.email, temporaryPassword: p.password, loginUrl: loginUrl(), firmName: p.firm },
    p.kind,
  );
  try {
    const result = await sendEmail({
      to: p.email,
      subject,
      text,
      kind: "staff_invite",
      related: { type: "employee", id: p.employeeId },
      idempotencyKey: `${p.kind === "invite" ? "staff-invite" : "staff-reset"}:${p.userId}:${crypto.randomUUID()}`,
    });
    if (result.status === "sent") return { status: "sent" };
    return { status: result.status, error: result.error ?? (result.status === "not_configured" ? "The firm's email domain isn't verified yet (Settings → Email)." : undefined) };
  } catch (err) {
    log("error", "invite email failed", { source: `action:people.${p.kind}`, userId: ctx.user.id, err });
    return { status: "failed", error: "The email service didn't answer." };
  }
}

function handout(person: { id: string; full_name: string; email: string; whatsapp: string | null; phone: string | null }, password: string, firm: string, invite: InviteOutcome, kind: "invite" | "reset"): LoginHandout {
  return {
    employeeId: person.id,
    fullName: person.full_name,
    email: person.email,
    temporaryPassword: password,
    whatsapp: normalizeWhatsAppNumber(person.whatsapp) ?? normalizeWhatsAppNumber(person.phone),
    loginUrl: loginUrl(),
    firmName: firm,
    invite,
    kind,
  };
}

async function emailTakenOnTeam(ctx: ActionContext, email: string, exceptId: string | null = null): Promise<boolean> {
  let q = ctx.supabase.from("employees").select("id", { count: "exact", head: true }).eq("email", email);
  if (exceptId) q = q.neq("id", exceptId);
  const { count, error } = await q;
  throwIfDbError(error);
  return (count ?? 0) > 0;
}

// -------------------------------------------------------------------------------------------------
// 1–2. Add a team member; the login is issued on save
// -------------------------------------------------------------------------------------------------

export const addTeamMember = defineAction(
  { name: "people.add", schema: AddPersonSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<LoginHandout>> => {
    if (!assignableRoles(ctx.user.role).includes(input.role)) {
      return fail("Only a Partner can add a Manager or a Partner.", { code: "forbidden", fieldErrors: { role: ["A Manager adds Employees only."] } });
    }
    const partnerOnly: Record<string, string[]> = {};
    if (ctx.user.role !== "partner") {
      if (input.cost_rate_per_hour) partnerOnly.cost_rate_per_hour = ["Only a Partner sets cost rates."];
      if (input.vault_access) partnerOnly.vault_access = ["Only a Partner grants vault access."];
      if (input.icai_membership_no) partnerOnly.icai_membership_no = ["Only a Partner records membership numbers."];
    }
    if (Object.keys(partnerOnly).length) return fail("Please check the highlighted fields.", { code: "forbidden", fieldErrors: partnerOnly });

    if ((await emailTakenOnTeam(ctx, input.email)) || (await emailHasLogin(input.email))) {
      return fail("Someone already uses that email address.", { code: "conflict", fieldErrors: { email: ["Someone already uses that email address."] } });
    }

    const { data: created, error } = await ctx.supabase
      .from("employees")
      .insert({
        full_name: input.full_name,
        email: input.email,
        phone: input.phone,
        whatsapp: input.whatsapp,
        department: input.department,
        designation: input.designation,
        date_of_joining: input.date_of_joining,
        staff_role: input.role,
        billing_rate_per_hour: input.billing_rate_per_hour === null ? null : Number(input.billing_rate_per_hour),
        cost_rate_per_hour: ctx.user.role === "partner" && input.cost_rate_per_hour !== null ? Number(input.cost_rate_per_hour) : null,
        vault_access: ctx.user.role === "partner" ? input.vault_access : false,
      })
      .select("id")
      .single();
    throwIfDbError(error, { uniqueField: "email", uniqueMessage: "Someone already uses that email address." });
    const employeeId = created!.id;

    let login;
    try {
      login = await createStaffLogin({
        employeeId,
        email: input.email,
        fullName: input.full_name,
        phone: input.phone,
        role: input.role,
        icaiMembershipNo: input.icai_membership_no,
      });
    } catch (err) {
      // §4.5 point 2: the login is part of saving. Without it, nothing is kept.
      await discardNewEmployee(employeeId).catch((e) => log("error", "could not discard the new record", { source: "action:people.add", userId: ctx.user.id, err: e }));
      throw err;
    }

    const firm = await firmName(ctx);
    const invite = await emailLogin(ctx, { employeeId, userId: login.userId, fullName: input.full_name, email: input.email, password: login.temporaryPassword, firm, kind: "invite" });

    await ctx.audit({
      event: "user_create",
      resourceType: "employee",
      resourceId: employeeId,
      details: { role: input.role, email: input.email, vault_access: ctx.user.role === "partner" ? input.vault_access : false, invite: invite.status },
    });
    ctx.after("Record the new team member", () =>
      logActivity({ entityType: "employee", entityId: employeeId, action: "created", description: `${input.full_name} joined as ${ROLE_LABEL[input.role]}; login issued.` }),
    );

    return ok(handout({ id: employeeId, full_name: input.full_name, email: input.email, whatsapp: input.whatsapp, phone: input.phone }, login.temporaryPassword, firm, invite, "invite"));
  },
);

// -------------------------------------------------------------------------------------------------
// Issue logins for records that have none (after an import, §4.5 point 8)
// -------------------------------------------------------------------------------------------------

async function issueOne(ctx: ActionContext, id: string, firm: string): Promise<LoginHandout> {
  const person = await loadManaged(ctx, id, "people.issue_login");
  if (person.profile_id) throw new ActionError(`${person.full_name} already has a login.`, { code: "conflict" });
  if (person.login_status === "disabled") throw new ActionError(`${person.full_name} is disabled. Enable them first.`, { code: "blocked" });
  const login = await createStaffLogin({ employeeId: person.id, email: person.email, fullName: person.full_name, phone: person.phone, role: person.role });
  const invite = await emailLogin(ctx, { employeeId: person.id, userId: login.userId, fullName: person.full_name, email: person.email, password: login.temporaryPassword, firm, kind: "invite" });
  await ctx.audit({ event: "user_create", resourceType: "employee", resourceId: person.id, details: { role: person.role, email: person.email, invite: invite.status } });
  return handout(person, login.temporaryPassword, firm, invite, "invite");
}

export const issueLogin = defineAction(
  { name: "people.issue_login", schema: PersonRefSchema, roles: MANAGERS },
  async ({ id }, ctx): Promise<ActionResult<LoginHandout>> => ok(await issueOne(ctx, id, await firmName(ctx))),
);

export interface IssueLoginsResult {
  created: LoginHandout[];
  failed: Array<{ id: string; name: string; error: string }>;
}

/** "Issue logins for N people" (§4.5 point 8): one at a time, so one refusal doesn't stop the rest. */
export const issueLogins = defineAction(
  { name: "people.issue_logins", schema: IssueLoginsSchema, roles: MANAGERS },
  async ({ ids }, ctx): Promise<ActionResult<IssueLoginsResult>> => {
    const firm = await firmName(ctx);
    const out: IssueLoginsResult = { created: [], failed: [] };
    const { data: names } = await ctx.supabase.from("people_overview").select("id, full_name").in("id", ids);
    const nameOf = new Map((names ?? []).map((n) => [n.id as string, n.full_name ?? ""]));
    for (const id of Array.from(new Set(ids))) {
      try {
        out.created.push(await issueOne(ctx, id, firm));
      } catch (err) {
        const message = err instanceof ActionError ? err.message : "The login couldn't be created. Try this person again.";
        if (!(err instanceof ActionError)) log("error", "bulk login failed for one person", { source: "action:people.issue_logins", userId: ctx.user.id, err });
        out.failed.push({ id, name: nameOf.get(id) ?? "", error: message });
      }
    }
    return ok(out);
  },
);

// -------------------------------------------------------------------------------------------------
// 3. Reset password (Managers: Employees only)
// -------------------------------------------------------------------------------------------------

export const resetPassword = defineAction(
  { name: "people.reset_password", schema: PersonRefSchema, roles: MANAGERS },
  async ({ id }, ctx): Promise<ActionResult<LoginHandout>> => {
    const person = await loadManaged(ctx, id, "people.reset_password");
    if (!person.profile_id) return fail(`${person.full_name} has no login yet. Use Issue login.`, { code: "blocked" });
    if (person.profile_id === ctx.user.id) return fail("Change your own password from Profile.", { code: "blocked" });
    if (person.login_status === "disabled") return fail(`${person.full_name} is disabled. Enable them first.`, { code: "blocked" });

    const password = await resetStaffPassword(person.profile_id, person.role);
    const firm = await firmName(ctx);
    const invite = await emailLogin(ctx, { employeeId: person.id, userId: person.profile_id, fullName: person.full_name, email: person.email, password, firm, kind: "reset" });
    await ctx.audit({ event: "password_change", resourceType: "employee", resourceId: person.id, details: { target_user: person.profile_id, by: "reset", invite: invite.status } });
    ctx.after("Record the password reset", () =>
      logActivity({ entityType: "employee", entityId: person.id, action: "password_reset", description: `${person.full_name}'s password was reset to a temporary one.` }),
    );
    return ok(handout(person, password, firm, invite, "reset"));
  },
);

// -------------------------------------------------------------------------------------------------
// 4. Change email: auth first, then the profile and the record together
// -------------------------------------------------------------------------------------------------

export const changeEmail = defineAction(
  { name: "people.change_email", schema: ChangeEmailSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const person = await loadManaged(ctx, input.id, "people.change_email");
    if (!sameInstant(person.updated_at, input.updated_at)) {
      return fail(`${person.full_name}'s record changed after you opened it. Reload to see the changes.`, { code: "conflict" });
    }
    if (person.email.toLowerCase() === input.email) return fail("That's already their email address.", { code: "validation", fieldErrors: { email: ["That's already their email address."] } });
    if ((await emailTakenOnTeam(ctx, input.email, person.id)) || (await emailHasLogin(input.email, person.profile_id))) {
      return fail("Someone already uses that email address.", { code: "conflict", fieldErrors: { email: ["Someone already uses that email address."] } });
    }

    if (person.profile_id) await moveAuthEmail(person.profile_id, input.email);

    const { data, error } = await ctx.supabase.rpc("change_staff_email", { p_employee: person.id, p_email: input.email, p_updated_at: input.updated_at });
    if (error) {
      if (person.profile_id) {
        await moveAuthEmail(person.profile_id, person.email).catch((err) =>
          log("error", "auth email left at the new address after the profile change failed", { source: "action:people.change_email", userId: ctx.user.id, err }),
        );
      }
      throwIfDbError(error, { uniqueField: "email", uniqueMessage: "Someone already uses that email address." });
    }

    await ctx.audit({ event: "user_update", resourceType: "employee", resourceId: person.id, details: { field: "email", before: person.email, after: input.email, login: !!person.profile_id } });
    ctx.after("Record the email change", () =>
      logActivity({ entityType: "employee", entityId: person.id, action: "email_changed", description: `Email changed from ${person.email} to ${input.email}.` }),
    );
    return ok({ updated_at: String(data ?? "") });
  },
);

// -------------------------------------------------------------------------------------------------
// 5. Change role (Partner only for Manager/Partner changes)
// -------------------------------------------------------------------------------------------------

export const changeRole = defineAction(
  { name: "people.change_role", schema: ChangeRoleSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const person = await loadManaged(ctx, input.id, "people.change_role");
    if (person.profile_id === ctx.user.id) return fail("You can't change your own role. Ask another Partner.", { code: "blocked" });
    if (!sameInstant(person.updated_at, input.updated_at)) {
      return fail(`${person.full_name}'s record changed after you opened it. Reload to see the changes.`, { code: "conflict" });
    }
    if (person.role === input.role) return fail(`${person.full_name} is already ${ROLE_LABEL[input.role] === "Employee" ? "an" : "a"} ${ROLE_LABEL[input.role]}.`, { code: "validation", fieldErrors: { role: ["Choose a different role."] } });
    if (person.role === "partner") {
      const { count, error } = await ctx.supabase
        .from("people_overview")
        .select("id", { count: "exact", head: true })
        .eq("role", "partner")
        .eq("login_status", "active")
        .neq("id", person.id);
      throwIfDbError(error);
      if ((count ?? 0) === 0) return fail(`${person.full_name} is the only active Partner. Make someone else a Partner first.`, { code: "blocked" });
    }

    // profiles.role is the authority: it changes first (§4.5 point 5).
    if (person.profile_id) {
      const { data, error } = await ctx.supabase.from("profiles").update({ role: input.role }).eq("id", person.profile_id).select("id");
      throwIfDbError(error);
      if (!data?.length) return fail("The role couldn't be changed. Reload and try again.", { code: "forbidden" });
    }
    const { data: emp, error: empError } = await ctx.supabase
      .from("employees")
      .update({ staff_role: input.role })
      .eq("id", person.id)
      .select("updated_at");
    throwIfDbError(empError);
    const updated_at = emp?.[0]?.updated_at ?? person.updated_at;

    await ctx.audit({ event: "permission_change", resourceType: "employee", resourceId: person.id, details: { field: "role", before: person.role, after: input.role, user: person.profile_id } });

    if (person.profile_id) {
      const userId = person.profile_id;
      ctx.after(
        "Update the sign-in token",
        () => writeAppRole(userId, input.role),
        `The role is changed. Their sign-in token still says ${ROLE_LABEL[person.role]} until their next sign-in, which repairs it; until then the database already treats them by the new role.`,
      );
      ctx.after(
        "Sign them out everywhere",
        () => endAllSessions(userId),
        "The role is changed, but their open sessions couldn't be ended. They get the new role when they next sign in.",
      );
      ctx.after("Tell them about the new role", () =>
        notify({
          to: { userIds: [userId] },
          type: "info",
          title: `Your role is now ${ROLE_LABEL[input.role]}`,
          body: `${ctx.user.fullName} changed your role from ${ROLE_LABEL[person.role]} to ${ROLE_LABEL[input.role]}. Sign in again to continue.`,
          linkUrl: "/profile",
          entity: { type: "employee", id: person.id },
        }),
      );
    }
    ctx.after("Record the role change", () =>
      logActivity({ entityType: "employee", entityId: person.id, action: "role_changed", description: `Role changed from ${ROLE_LABEL[person.role]} to ${ROLE_LABEL[input.role]}.` }),
    );
    return ok({ updated_at });
  },
);

// -------------------------------------------------------------------------------------------------
// Edit details (§4.5 point 1 fields, §7.11.2 Profile)
// -------------------------------------------------------------------------------------------------

export const updatePerson = defineAction(
  { name: "people.update", schema: UpdatePersonSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const person = await loadManaged(ctx, input.id, "people.update");
    const isPartner = ctx.user.role === "partner";

    const { data: before, error: readError } = await ctx.supabase
      .from("employees")
      .select("full_name, phone, whatsapp, department, designation, date_of_joining, billing_rate_per_hour, vault_access, updated_at")
      .eq("id", person.id)
      .single();
    throwIfDbError(readError);
    let costBefore: number | null = null;
    if (isPartner) {
      const { data: cost, error: costError } = await ctx.supabase.from("employee_cost_rates").select("cost_rate_per_hour").eq("id", person.id).maybeSingle();
      throwIfDbError(costError);
      costBefore = cost?.cost_rate_per_hour ?? null;
    }

    const patch: TablesUpdate<"employees"> = {
      full_name: input.full_name,
      phone: input.phone,
      whatsapp: input.whatsapp,
      department: input.department,
      designation: input.designation,
      date_of_joining: input.date_of_joining,
      billing_rate_per_hour: input.billing_rate_per_hour === null ? null : Number(input.billing_rate_per_hour),
    };
    if (isPartner) {
      patch.cost_rate_per_hour = input.cost_rate_per_hour === null ? null : Number(input.cost_rate_per_hour);
      if (input.vault_access !== undefined) patch.vault_access = input.vault_access;
    }

    const { data, error } = await ctx.supabase.from("employees").update(patch).eq("id", person.id).eq("updated_at", input.updated_at).select("updated_at");
    throwIfDbError(error);
    if (!data || data.length === 0) {
      const { data: now } = await ctx.supabase.from("employees").select("updated_at").eq("id", person.id).maybeSingle();
      const at = now?.updated_at ? new Date(now.updated_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "";
      return fail(`${person.full_name}'s record was changed${at ? ` at ${at}` : ""} after you opened it. Reload to see the changes.`, { code: "conflict" });
    }

    if (person.profile_id) {
      const profilePatch: TablesUpdate<"profiles"> = { full_name: input.full_name, phone: input.phone };
      if (isPartner && person.role === "partner") profilePatch.icai_membership_no = input.icai_membership_no;
      const { error: pError } = await ctx.supabase.from("profiles").update(profilePatch).eq("id", person.profile_id);
      throwIfDbError(pError);
    }

    const was0 = { ...before!, cost_rate_per_hour: costBefore };
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => {
      const was = (was0 as Record<string, unknown>)[k];
      const now = patch[k];
      return String(was ?? "") !== String(now ?? "") && !(typeof now === "number" && Number(was) === now);
    });
    const vaultChanged = isPartner && input.vault_access !== undefined && input.vault_access !== was0.vault_access;
    await ctx.audit({
      event: vaultChanged ? "permission_change" : "data_update",
      resourceType: "employee",
      resourceId: person.id,
      details: { fields: changed, vault_access: vaultChanged ? { before: was0.vault_access, after: input.vault_access } : undefined },
    });
    ctx.after("Record the change", () =>
      logActivity({
        entityType: "employee",
        entityId: person.id,
        action: vaultChanged ? "vault_access_changed" : "updated",
        description: vaultChanged ? `Vault access ${input.vault_access ? "granted" : "removed"}.` : "Details updated.",
      }),
    );
    return ok({ updated_at: data[0].updated_at });
  },
);

// -------------------------------------------------------------------------------------------------
// 6. Disable / enable; 7. Delete (Partner); "Reassign all work to…"
// -------------------------------------------------------------------------------------------------

export const setPersonActive = defineAction(
  { name: "people.set_active", schema: SetActiveSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const person = await loadManaged(ctx, input.id, input.active ? "people.enable" : "people.disable");
    const { data, error } = await ctx.supabase.rpc("set_staff_active", { p_employee: person.id, p_active: input.active, p_updated_at: input.updated_at });
    throwIfDbError(error);
    const result = (data ?? {}) as { updated_at?: string; covers_ended?: number; sessions_closed?: number };

    await ctx.audit({
      event: input.active ? "user_update" : "user_disable",
      resourceType: "employee",
      resourceId: person.id,
      details: { active: input.active, covers_ended: result.covers_ended ?? 0, user: person.profile_id },
    });
    if (person.profile_id) {
      const userId = person.profile_id;
      ctx.after(
        input.active ? "Lift the sign-in block" : "Block sign-in",
        () => setLoginBanned(userId, !input.active),
        input.active
          ? `${person.full_name} is enabled, but the sign-in block couldn't be lifted. Try Enable again in a minute.`
          : `${person.full_name} is disabled and can't use the app; their sign-in block couldn't be set, so they may see a sign-in error instead.`,
      );
    }
    return ok({ updated_at: result.updated_at ?? "" });
  },
);

export const deletePerson = defineAction(
  { name: "people.delete", schema: DeletePersonSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ deleted: true }>> => {
    const person = await loadManaged(ctx, input.id, "people.delete");
    const { error } = await ctx.supabase.rpc("delete_staff", { p_employee: person.id, p_updated_at: input.updated_at });
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "employee", resourceId: person.id, details: { name: person.full_name, email: person.email, role: person.role, user: person.profile_id } });
    if (person.profile_id) {
      const userId = person.profile_id;
      ctx.after("Block sign-in", () => setLoginBanned(userId, true), `${person.full_name} is deleted; their sign-in block couldn't be set, but their access is already gone.`);
    }
    return ok({ deleted: true as const });
  },
);

export interface ReassignResult {
  tasks: number;
  tasks_reviewer_cleared: number;
  reviews: number;
  reviews_cleared: number;
  clients: number;
  team: number;
  notices: number;
  leads: number;
}

export const reassignAllWork = defineAction(
  { name: "people.reassign_all_work", schema: ReassignWorkSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<ReassignResult>> => {
    const from = await loadManaged(ctx, input.from_employee_id, "people.reassign_all_work");
    const { data: to, error: toError } = await ctx.supabase.from("people_overview").select("id, profile_id, full_name, login_status").eq("id", input.to_employee_id).maybeSingle();
    throwIfDbError(toError);
    if (!to || to.login_status === "disabled") {
      return fail("Choose someone active to take the work.", { code: "validation", fieldErrors: { to_employee_id: ["Choose someone active to take the work."] } });
    }

    const { data, error } = await ctx.supabase.rpc("reassign_all_work", { p_from_employee: from.id, p_to_employee: input.to_employee_id });
    throwIfDbError(error);
    const r = (data ?? {}) as Partial<ReassignResult>;
    const result: ReassignResult = {
      tasks: r.tasks ?? 0,
      tasks_reviewer_cleared: r.tasks_reviewer_cleared ?? 0,
      reviews: r.reviews ?? 0,
      reviews_cleared: r.reviews_cleared ?? 0,
      clients: r.clients ?? 0,
      team: r.team ?? 0,
      notices: r.notices ?? 0,
      leads: r.leads ?? 0,
    };
    await ctx.audit({ event: "data_update", resourceType: "employee", resourceId: from.id, action: "people.reassign_all_work", details: { to: input.to_employee_id, ...result } });

    const moved = result.tasks + result.reviews + result.clients + result.team + result.notices + result.leads;
    if (moved > 0) {
      ctx.after("Tell the person taking the work", () =>
        notify({
          to: { employeeIds: [input.to_employee_id] },
          type: result.tasks > 0 ? "task_assigned" : "info",
          title: `${from.full_name}'s work is now yours`,
          body: [
            result.tasks ? `${result.tasks} open task${result.tasks === 1 ? "" : "s"} (waiting for you to accept)` : null,
            result.reviews ? `${result.reviews} to review` : null,
            result.clients ? `${result.clients} client${result.clients === 1 ? "" : "s"} you now own` : null,
            result.team ? `${result.team} engagement team place${result.team === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Open notices and leads moved to you.",
          linkUrl: `/people/${input.to_employee_id}?tab=work`,
          entity: { type: "employee", id: from.id },
        }),
      );
    }
    return ok(result);
  },
);

// -------------------------------------------------------------------------------------------------
// 8. Bulk import (records only; logins in a second step)
// -------------------------------------------------------------------------------------------------

export interface ImportResult {
  created: Array<{ id: string; full_name: string; email: string; role: StaffRole }>;
  skipped: Array<{ line: number; errors: string[] }>;
}

export const importPeople = defineAction(
  { name: "people.import", schema: ImportPeopleSchema, roles: MANAGERS },
  async ({ rows }, ctx): Promise<ActionResult<ImportResult>> => {
    const emails = rows.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean);
    const [team, logins] = await Promise.all([
      ctx.supabase.from("employees").select("email").in("email", emails).limit(1000),
      emailsWithLogin(emails),
    ]);
    throwIfDbError(team.error);
    const existing = new Set<string>([...(team.data ?? []).map((e) => String(e.email).toLowerCase()), ...logins]);
    const checked = checkImportRows(rows, { actorRole: ctx.user.role, existingEmails: existing });
    const good = checked.filter((c) => c.row !== null);
    const skipped = checked.filter((c) => c.row === null).map((c) => ({ line: c.line, errors: c.errors }));
    if (good.length === 0) return fail("No row can be imported. Fix the problems shown and try again.", { code: "validation" });

    const { data, error } = await ctx.supabase
      .from("employees")
      .insert(
        good.map((c) => ({
          full_name: c.row!.full_name,
          email: c.row!.email,
          phone: c.row!.phone,
          department: c.row!.department,
          designation: c.row!.designation,
          date_of_joining: c.row!.date_of_joining,
          staff_role: c.row!.role,
        })),
      )
      .select("id, full_name, email, staff_role");
    throwIfDbError(error, { uniqueMessage: "Someone in the file was added by someone else meanwhile. Check the file again." });

    const created = (data ?? []).map((d) => ({ id: d.id, full_name: d.full_name, email: String(d.email), role: d.staff_role as StaffRole }));
    await ctx.audit({ event: "data_create", resourceType: "employee", action: "people.import", details: { created: created.length, skipped: skipped.length } });
    ctx.after("Record the import", async () => {
      for (const c of created) await logActivity({ entityType: "employee", entityId: c.id, action: "imported", description: `${c.full_name} added by import as ${ROLE_LABEL[c.role]}; no login yet.` });
    });
    return ok({ created, skipped });
  },
);

// -------------------------------------------------------------------------------------------------
// Reset someone's two-step sign-in (Partner)
// -------------------------------------------------------------------------------------------------

export const resetTwoStepSignIn = defineAction(
  { name: "people.reset_two_step", schema: PersonRefSchema, roles: ["partner"] },
  async ({ id }, ctx): Promise<ActionResult<{ removed: number }>> => {
    const person = await loadManaged(ctx, id, "people.reset_two_step");
    if (!person.profile_id) return fail(`${person.full_name} has no login yet.`, { code: "blocked" });
    if (person.profile_id === ctx.user.id) return fail("Ask another Partner to reset your own two-step sign-in.", { code: "blocked" });
    const removed = await resetTwoStep(person.profile_id);
    await ctx.audit({ event: "permission_change", resourceType: "employee", resourceId: person.id, action: "people.reset_two_step", details: { user: person.profile_id, factors_removed: removed } });
    const userId = person.profile_id;
    ctx.after("Tell them to set it up again", () =>
      notify({
        to: { userIds: [userId] },
        type: "security_alert",
        title: "Your two-step sign-in was reset",
        body: `${ctx.user.fullName} reset your two-step sign-in. Set up your authenticator app again when you next sign in.`,
        linkUrl: "/profile",
        entity: { type: "employee", id: person.id },
      }),
    );
    return ok({ removed });
  },
);

// -------------------------------------------------------------------------------------------------
// Open work for the disable / delete dialogs (§4.5: "the dialog shows the count")
// -------------------------------------------------------------------------------------------------

export const loadOpenWork = defineAction(
  { name: "people.open_work", schema: z.object({ id: z.uuid() }), roles: MANAGERS },
  async ({ id }, ctx) => {
    const { data, error } = await ctx.supabase.rpc("employee_open_work", { p_employee: id });
    throwIfDbError(error);
    const d = (data ?? {}) as Record<string, number>;
    return ok({
      open_tasks: d.open_tasks ?? 0,
      review_tasks: d.review_tasks ?? 0,
      owned_clients: d.owned_clients ?? 0,
      team_clients: d.team_clients ?? 0,
      open_notices: d.open_notices ?? 0,
      open_leads: d.open_leads ?? 0,
    });
  },
);
