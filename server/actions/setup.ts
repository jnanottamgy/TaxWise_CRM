"use server";

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";
import { fail, ok, unexpectedMessage, type ActionResult, type FieldErrors } from "@/lib/result";
import { log, logUnexpected } from "@/lib/log";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/server/admin";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { SetupSchema, type SetupInput } from "@/lib/schemas/auth";
import { auditAuthEvent, isFirstRun, requestMeta, startActivityClock } from "@/app/(auth)/_lib/server";

/**
 * First run (§4.3). Reachable only while `profiles` is empty. Creates the first Partner's login
 * (`app_metadata.role = 'partner'`, through the service role), their `profiles` and `employees`
 * rows, and the `firm_settings` row (or confirms the seeded one); then signs them in. They land on
 * the authenticator set-up (§12, required for Partners) and from there on the dashboard's setup
 * checklist (§7.2).
 */

const CHECK_FIELDS = "Please check the highlighted fields.";

function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function completeSetup(input: SetupInput): Promise<ActionResult<{ redirectTo: string }>> {
  let createdUserId: string | null = null;
  try {
    const meta = await requestMeta();
    const parsed = SetupSchema.safeParse(input);
    if (!parsed.success) {
      return fail(CHECK_FIELDS, { code: "validation", fieldErrors: fieldErrorsOf(parsed.error) });
    }
    const v = parsed.data;

    // If the operator named the first Partner at deployment (§17), only that email may claim it.
    const expected = env.firstPartnerEmail()?.trim().toLowerCase();
    if (expected && v.email !== expected) {
      return fail(CHECK_FIELDS, {
        code: "validation",
        fieldErrors: { email: ["Use the first Partner's email address set for this installation."] },
      });
    }

    const limit = await checkRateLimit({
      scope: "setup",
      identity: [meta.ip],
      ...RATE_LIMITS.setup,
      audit: { email: v.email, ip: meta.ip, userAgent: meta.userAgent },
    });
    if (!limit.allowed) return fail("Too many attempts. Try again in 15 minutes.", { code: "rate_limited" });

    if (!(await isFirstRun())) {
      return fail("TaxWise is already set up. Sign in instead.", { code: "blocked" });
    }

    const admin = createAdminClient();

    // 1. The login. The role goes into app_metadata only (§0.1 rule 9); nothing in user_metadata.
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: v.email,
      password: v.password,
      email_confirm: true,
      app_metadata: { role: "partner", must_change_password: false },
    });
    if (createError || !created?.user) {
      if (createError?.code === "email_exists" || createError?.code === "user_already_exists") {
        return fail(CHECK_FIELDS, {
          code: "validation",
          fieldErrors: { email: ["This email already has a login in Supabase Auth. Use another email, or remove that login first."] },
        });
      }
      if (createError?.code === "weak_password") {
        return fail(CHECK_FIELDS, {
          code: "validation",
          fieldErrors: { password: ["Choose a stronger password: longer, with a mix of letters, numbers and symbols."] },
        });
      }
      throw createError ?? new Error("createUser returned no user");
    }
    const userId = created.user.id;
    createdUserId = userId;

    // 2. The authority for every server check (§0.1 rule 9).
    // Upserts, in case a database trigger already created the row when the auth user appeared.
    const { error: profileError } = await admin.from("profiles").upsert(
      { id: userId, full_name: v.fullName, email: v.email, role: "partner", is_active: true, must_change_password: false },
      { onConflict: "id" },
    );
    if (profileError) throw profileError;

    // 3. Partners have a staff record too (§5.2).
    const { error: employeeError } = await admin.from("employees").upsert(
      { profile_id: userId, full_name: v.fullName, email: v.email, designation: "Partner", staff_role: "partner", is_active: true },
      { onConflict: "profile_id" },
    );
    if (employeeError) throw employeeError;
    createdUserId = null; // the Partner exists from here on; nothing below undoes it

    const warnings: string[] = [];

    // 4. The firm's details: create the row if missing, or store what was confirmed (§4.3).
    try {
      const { error: firmError } = await admin.from("firm_settings").upsert(
        {
          id: 1,
          firm_name: v.firmName,
          tagline: v.tagline ?? null,
          address: v.address,
          city: v.city,
          state_code: v.stateCode,
          pincode: v.pincode,
          phone: v.phone ?? null,
          email: v.firmEmail,
          website: v.website ?? null,
          gstin: v.gstin ?? null,
          pan: v.pan ?? null,
          updated_by: userId,
        },
        { onConflict: "id" },
      );
      if (firmError) throw firmError;
    } catch (err) {
      const ref = logUnexpected(err, { source: "action:setup.firm_settings", userId });
      warnings.push(`The firm's details didn't save. Add them in Settings, Firm. (Ref ${ref})`);
    }

    await auditAuthEvent({
      event: "user_create",
      action: "setup.first_partner",
      success: true,
      details: { role: "partner" },
      userId,
      email: v.email,
      role: "partner",
      meta,
    });

    // 5. Sign them in.
    const supabase = await createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: v.email, password: v.password });
    if (signInError) {
      log("error", "sign-in after setup failed", { source: "action:setup", userId, err: signInError });
      warnings.push("Your login is ready, but we couldn't sign you in automatically. Sign in with the email and password you just chose.");
      return ok({ redirectTo: "/login" }, warnings);
    }
    await startActivityClock();
    await auditAuthEvent({
      event: "login_success",
      action: "auth.sign_in",
      success: true,
      details: { via: "setup", aal: "aal1" },
      userId,
      email: v.email,
      role: "partner",
      meta,
      supabase,
    });

    return ok({ redirectTo: `/mfa?next=${encodeURIComponent("/dashboard")}` }, warnings);
  } catch (err) {
    unstable_rethrow(err);
    if (createdUserId) {
      // Undo a half-made Partner (deleting the auth user cascades to the profile) so set-up can be retried.
      try {
        const { error } = await createAdminClient().auth.admin.deleteUser(createdUserId);
        if (error) throw error;
      } catch (cleanupErr) {
        log("error", "setup cleanup failed", { source: "action:setup", userId: createdUserId, err: cleanupErr });
      }
    }
    const ref = logUnexpected(err, { source: "action:setup" });
    return fail(unexpectedMessage(ref), { code: "unexpected", ref });
  }
}
