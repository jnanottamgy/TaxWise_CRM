"use server";

import type { Json } from "@/lib/database.types";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { log } from "@/lib/log";
import {
  IMAGE_CONTENT_TYPE,
  IMAGE_EXTENSION,
  ImageConfirmSchema,
  ImageRemoveSchema,
  ImageUploadRequestSchema,
  MESSAGING_PREFS_KEY,
  MembershipSchema,
  MessagingPrefsSchema,
  NOTIFICATION_PREFS_KEY,
  NotificationPrefsSchema,
  PROFILE_IMAGE_LIMITS,
  ProfileDetailsSchema,
  SignOutOthersSchema,
  checkProfileImage,
  notificationEventsFor,
  profileImagePathPattern,
  type ProfileImageKind,
} from "@/lib/schemas/profile";

/**
 * Profile (§7.1, §7.17): every signed-in staff member edits their own name, phone and photo, their
 * notification preferences, and signs out their other sessions; Partners also keep their ICAI
 * membership number and signature image (used on PDFs). Everything runs under the person's own
 * session (profiles_update_own; the 0105 storage policies; update_my_contact, 0108).
 *
 * Each form carries the values it showed as its concurrency check (§13): preferences writes (theme,
 * density, favourites, the FY switcher) also touch the profile row, so its updated_at would report
 * conflicts that aren't there. Changing the password is changePassword in server/actions/auth.ts;
 * theme and density are saveTheme / saveDensity in server/actions/preferences.ts.
 */

const STAFF = ["partner", "manager", "employee"] as const;
const BUCKET = "profile-images";

type MyProfile = {
  full_name: string;
  phone: string | null;
  icai_membership_no: string | null;
  avatar_path: string | null;
  signature_path: string | null;
  preferences: Json;
  updated_at: string;
};

async function myProfile(ctx: ActionContext): Promise<MyProfile> {
  const { data, error } = await ctx.supabase
    .from("profiles")
    .select("full_name, phone, icai_membership_no, avatar_path, signature_path, preferences, updated_at")
    .eq("id", ctx.user.id)
    .single();
  throwIfDbError(error);
  return data!;
}

function conflict(what: string): ActionResult<never> {
  return fail(`Your ${what} was changed after you opened this page (by a Partner, or in another tab). Reload to see the changes.`, { code: "conflict" });
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim() === (b ?? "").trim();

/**
 * Writes one key of `profiles.preferences` without losing a concurrent write to another key (theme,
 * density, favourites): compare-and-set on updated_at, retried a few times.
 */
async function mergePreferenceKey(ctx: ActionContext, key: string, value: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await myProfile(ctx);
    const prefs = before.preferences && typeof before.preferences === "object" && !Array.isArray(before.preferences) ? { ...(before.preferences as Record<string, unknown>) } : {};
    const current = prefs[key];
    const currentObj = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
    prefs[key] = { ...currentObj, ...value, updated_at: new Date().toISOString() };
    const { data, error } = await ctx.supabase
      .from("profiles")
      .update({ preferences: prefs as Json })
      .eq("id", ctx.user.id)
      .eq("updated_at", before.updated_at)
      .select("id");
    throwIfDbError(error);
    if (data?.length) return;
  }
  throw new ActionError("Your preferences couldn't be saved because your profile kept changing. Try again.", { code: "conflict" });
}

// -------------------------------------------------------------------------------------------------
// Name and phone; ICAI membership number
// -------------------------------------------------------------------------------------------------

export const updateMyDetails = defineAction(
  { name: "profile.details", schema: ProfileDetailsSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ full_name: string; phone: string | null; changed: boolean }>> => {
    const before = await myProfile(ctx);
    if (!same(before.full_name, input.was_full_name) || !same(before.phone, input.was_phone)) return conflict("name or phone");
    const nameChanged = !same(before.full_name, input.full_name);
    const phoneChanged = !same(before.phone, input.phone);
    if (!nameChanged && !phoneChanged) return ok({ full_name: before.full_name, phone: before.phone, changed: false });
    // update_my_contact checks the same values again under a row lock (0108).
    const { error } = await ctx.supabase.rpc("update_my_contact", {
      p_full_name: input.full_name,
      p_phone: input.phone ?? "",
      p_was_full_name: before.full_name,
      p_was_phone: before.phone ?? "",
    });
    throwIfDbError(error);
    await ctx.audit({
      event: "user_update",
      resourceType: "profiles",
      resourceId: ctx.user.id,
      action: "profile.details",
      details: { fields: [...(nameChanged ? ["full_name"] : []), ...(phoneChanged ? ["phone"] : [])] },
    });
    return ok({ full_name: input.full_name, phone: input.phone, changed: true });
  },
);

export const saveMyMembershipNumber = defineAction(
  { name: "profile.membership", schema: MembershipSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ icai_membership_no: string | null; changed: boolean }>> => {
    const before = await myProfile(ctx);
    if (!same(before.icai_membership_no, input.was_icai_membership_no)) return conflict("ICAI membership number");
    if (same(before.icai_membership_no, input.icai_membership_no)) return ok({ icai_membership_no: before.icai_membership_no, changed: false });
    let q = ctx.supabase.from("profiles").update({ icai_membership_no: input.icai_membership_no }).eq("id", ctx.user.id);
    q = before.icai_membership_no === null ? q.is("icai_membership_no", null) : q.eq("icai_membership_no", before.icai_membership_no);
    const { data, error } = await q.select("id");
    throwIfDbError(error);
    if (!data?.length) return conflict("ICAI membership number");
    await ctx.audit({
      event: "user_update",
      resourceType: "profiles",
      resourceId: ctx.user.id,
      action: "profile.membership",
      details: { from: before.icai_membership_no, to: input.icai_membership_no },
    });
    return ok({ icai_membership_no: input.icai_membership_no, changed: true });
  },
);

// -------------------------------------------------------------------------------------------------
// Photo and signature: a signed upload to the private bucket, then a server check of the bytes
// -------------------------------------------------------------------------------------------------

function column(kind: ProfileImageKind): "avatar_path" | "signature_path" {
  return kind === "avatar" ? "avatar_path" : "signature_path";
}

const imageWhat = (kind: ProfileImageKind) => (kind === "avatar" ? "photo" : "signature");

/** Sets the photo or signature path only if it is still the one the page showed. */
async function swapImagePath(ctx: ActionContext, kind: ProfileImageKind, was: string | null, next: string | null): Promise<boolean> {
  const col = column(kind);
  let q = ctx.supabase.from("profiles").update(col === "avatar_path" ? { avatar_path: next } : { signature_path: next }).eq("id", ctx.user.id);
  q = was === null ? q.is(col, null) : q.eq(col, was);
  const { data, error } = await q.select("id");
  throwIfDbError(error);
  return !!data?.length;
}

export const requestImageUpload = defineAction(
  { name: "profile.image_request", schema: ImageUploadRequestSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ path: string; token: string; contentType: string }>> => {
    if (input.kind === "signature" && ctx.user.role !== "partner") return fail("Only Partners keep a signature image.", { code: "forbidden" });
    const limits = PROFILE_IMAGE_LIMITS[input.kind];
    if (!limits.formats.includes(input.format)) return fail(input.kind === "avatar" ? "Upload a PNG, JPG or WebP image." : "Upload a PNG or JPG image.", { code: "validation" });
    if (input.size > limits.maxBytes) return fail(`Use a file of at most ${limits.maxBytes / (1024 * 1024)} MB.`, { code: "validation" });
    const path = `${ctx.user.id}/${input.kind}-${crypto.randomUUID()}.${IMAGE_EXTENSION[input.format]}`;
    const { data, error } = await ctx.supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw Object.assign(new Error(`profile image upload URL: ${error?.message ?? "no data"}`), { code: "storage" });
    return ok({ path, token: data.token, contentType: IMAGE_CONTENT_TYPE[input.format] });
  },
);

export const confirmImage = defineAction(
  { name: "profile.image_confirm", schema: ImageConfirmSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ path: string; url: string | null }>> => {
    if (input.kind === "signature" && ctx.user.role !== "partner") return fail("Only Partners keep a signature image.", { code: "forbidden" });
    if (!profileImagePathPattern(input.kind).test(input.path) || !input.path.startsWith(`${ctx.user.id}/`)) {
      return fail("Upload the file again.", { code: "validation" });
    }

    const discard = async () => {
      const { error } = await ctx.supabase.storage.from(BUCKET).remove([input.path]);
      if (error) log("warn", "rejected profile image left in storage", { source: "action:profile.image_confirm", userId: ctx.user.id, err: error });
    };

    const before = await myProfile(ctx);
    const col = column(input.kind);
    if (!same(before[col], input.was_path)) {
      await discard();
      return conflict(imageWhat(input.kind));
    }

    const { data: blob, error: dlError } = await ctx.supabase.storage.from(BUCKET).download(input.path);
    if (dlError || !blob) throw new ActionError("The upload didn't arrive. Try again.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const check = checkProfileImage(input.kind, bytes, bytes.length);
    if (!check.ok) {
      await discard();
      throw new ActionError(check.error, { fieldErrors: { file: [check.error] } });
    }
    if (!input.path.endsWith(`.${IMAGE_EXTENSION[check.format]}`)) {
      await discard();
      throw new ActionError("The file's contents don't match its type. Upload it again.");
    }

    if (!(await swapImagePath(ctx, input.kind, before[col], input.path))) {
      await discard();
      return conflict(imageWhat(input.kind));
    }
    await ctx.audit({ event: "file_upload", resourceType: "profiles", resourceId: ctx.user.id, action: `profile.${input.kind}`, details: { bytes: bytes.length, format: check.format } });

    const old = before[col];
    if (old && old !== input.path) {
      ctx.after(
        "Remove the old file",
        async () => {
          const { error: rmError } = await ctx.supabase.storage.from(BUCKET).remove([old]);
          if (rmError) throw new Error(rmError.message);
        },
        "The new image is saved; the old file couldn't be removed from storage. It does no harm.",
      );
    }
    const { data: signed } = await ctx.supabase.storage.from(BUCKET).createSignedUrl(input.path, 300);
    return ok({ path: input.path, url: signed?.signedUrl ?? null });
  },
);

export const removeImage = defineAction(
  { name: "profile.image_remove", schema: ImageRemoveSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ removed: boolean }>> => {
    const before = await myProfile(ctx);
    const col = column(input.kind);
    const old = before[col];
    if (!same(old, input.was_path)) return conflict(imageWhat(input.kind));
    if (!old) return ok({ removed: false });
    if (!(await swapImagePath(ctx, input.kind, old, null))) return conflict(imageWhat(input.kind));
    await ctx.audit({ event: "data_delete", resourceType: "profiles", resourceId: ctx.user.id, action: `profile.${input.kind}_remove` });
    ctx.after(
      "Remove the file",
      async () => {
        const { error: rmError } = await ctx.supabase.storage.from(BUCKET).remove([old]);
        if (rmError) throw new Error(rmError.message);
      },
      "The image is removed from your profile; the file couldn't be deleted from storage. It does no harm.",
    );
    return ok({ removed: true });
  },
);

// -------------------------------------------------------------------------------------------------
// Notification preferences (§7.17): in-app always; email per event
// -------------------------------------------------------------------------------------------------

export const saveNotificationPreferences = defineAction(
  { name: "profile.notifications", schema: NotificationPrefsSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ saved: number }>> => {
    const allowed = new Set(notificationEventsFor(ctx.user.role).map((e) => e.type as string));
    const email: Record<string, boolean> = {};
    for (const [type, on] of Object.entries(input.email)) if (allowed.has(type) && typeof on === "boolean") email[type] = on;
    // The daily digest carries receivables: Partners only (§4.1, §7.17).
    const digest = ctx.user.role === "partner" && typeof input.digest === "boolean" ? { digest: input.digest } : {};
    await mergePreferenceKey(ctx, NOTIFICATION_PREFS_KEY, { email, ...digest });
    await ctx.audit({
      event: "user_update",
      resourceType: "profiles",
      resourceId: ctx.user.id,
      action: "profile.notifications",
      details: { email_on: Object.entries(email).filter(([, v]) => v).map(([k]) => k), ...digest },
    });
    return ok({ saved: Object.keys(email).length });
  },
);

// -------------------------------------------------------------------------------------------------
// Messaging (§7.13.2, §7.25.10): "Add my signature to WhatsApp drafts"
// -------------------------------------------------------------------------------------------------

export const saveMessagingPreferences = defineAction(
  { name: "profile.messaging", schema: MessagingPrefsSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ whatsapp_signature: boolean }>> => {
    await mergePreferenceKey(ctx, MESSAGING_PREFS_KEY, { whatsapp_signature: input.whatsapp_signature });
    await ctx.audit({
      event: "user_update",
      resourceType: "profiles",
      resourceId: ctx.user.id,
      action: "profile.messaging",
      details: { whatsapp_signature: input.whatsapp_signature },
    });
    return ok({ whatsapp_signature: input.whatsapp_signature });
  },
);

// -------------------------------------------------------------------------------------------------
// Sessions (§7.1 "active sessions … sign out other sessions")
// -------------------------------------------------------------------------------------------------

export const signOutOtherSessions = defineAction(
  { name: "profile.sign_out_others", schema: SignOutOthersSchema, roles: STAFF },
  async (_input, ctx): Promise<ActionResult<{ done: true }>> => {
    const { error } = await ctx.supabase.auth.signOut({ scope: "others" });
    if (error) throw Object.assign(new Error(`sign out others failed: ${error.message}`), { code: error.code });
    await ctx.audit({ event: "logout", resourceType: "auth", resourceId: ctx.user.id, action: "profile.sign_out_others", details: { scope: "others" } });
    return ok({ done: true as const });
  },
);
