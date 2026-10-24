"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { nextNoticeVersion, noticeMissingTopics } from "@/lib/domain/dpdp";
import { ConsentWithdrawSchema, DeleteNoticeSchema, NoticeDraftSchema, PublishNoticeSchema } from "@/lib/schemas/dpdp";
import { logActivity } from "@/server/activity";
import { notify } from "@/server/notify";

/**
 * Privacy notice versions (§6.10 "versioned in privacy_notices", §7.21 Settings → Data "privacy
 * notice editor") and consent records. Partners only: Settings is a Partner's (§7.21) and data
 * protection in the quality module is "Partner; Managers read-only" (§7.15.4); RLS (0039) refuses
 * anyone else's write as well.
 *
 *   saveNoticeDraft     the one open draft: created as the next version ("v3"), then edited with
 *                       the row's updated_at (§13). A published version is frozen (0197 guard).
 *   publishNotice       makes the draft the current version (publish_privacy_notice, 0197): portal
 *                       users acknowledge it at the welcome gate (§7.22) and new leads see it.
 *   deleteNoticeDraft   an unpublished draft only.
 *   withdrawConsent     records a person's withdrawal of their consent (DPDP Act s.6(4)).
 *
 * Each writes an audit row; history and notices run after the save and never fail it (§0.1 rule 5).
 */

const PARTNER = ["partner"] as const;
const STALE = "This version was changed by someone else. Reload to see their changes.";

export const saveNoticeDraft = defineAction(
  { name: "privacy_notices.save_draft", schema: NoticeDraftSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string; version: string; updatedAt: string; missingTopics: string[] }>> => {
    const missingTopics = noticeMissingTopics(input.body);
    if (input.id) {
      if (!input.updatedAt) return fail(STALE, { code: "conflict" });
      const { data: current, error: readError } = await ctx.supabase.from("privacy_notices").select("id, version, published_at").eq("id", input.id).maybeSingle();
      throwIfDbError(readError);
      if (!current) return fail("That version no longer exists.", { code: "not_found" });
      if (current.published_at) return fail("A published notice can't be changed. Start a new version from it instead.", { code: "blocked" });
      const { data, error } = await ctx.supabase
        .from("privacy_notices")
        .update({ body: input.body, change_summary: input.changeSummary })
        .eq("id", input.id)
        .eq("updated_at", input.updatedAt)
        .select("id, version, updated_at");
      throwIfDbError(error);
      if (!data?.length) return fail(STALE, { code: "conflict" });
      await ctx.audit({ event: "config_change", resourceType: "privacy_notice", resourceId: input.id, action: "privacy_notices.edit_draft", details: { version: current.version, length: input.body.length } });
      return ok({ id: data[0].id, version: data[0].version, updatedAt: data[0].updated_at, missingTopics });
    }

    const { data: all, error: listError } = await ctx.supabase.from("privacy_notices").select("id, version, published_at").limit(1000);
    throwIfDbError(listError);
    const draft = (all ?? []).find((n) => !n.published_at);
    if (draft) return fail(`There is already a draft (${draft.version}). Edit or delete it before starting another.`, { code: "blocked" });
    const version = nextNoticeVersion((all ?? []).map((n) => n.version));
    const { data, error } = await ctx.supabase
      .from("privacy_notices")
      .insert({ version, body: input.body, change_summary: input.changeSummary })
      .select("id, version, updated_at")
      .single();
    throwIfDbError(error, { uniqueMessage: "Someone else started that version a moment ago. Reload to see it." });
    await ctx.audit({ event: "config_change", resourceType: "privacy_notice", resourceId: data!.id, action: "privacy_notices.new_draft", details: { version, length: input.body.length } });
    ctx.after("Record it in the notice's history", () =>
      logActivity({ entityType: "privacy_notice", entityId: data!.id, action: "privacy_notice_drafted", description: `Version ${version} drafted by ${ctx.user.fullName}` }),
    );
    return ok({ id: data!.id, version: data!.version, updatedAt: data!.updated_at, missingTopics });
  },
);

export const publishNotice = defineAction(
  { name: "privacy_notices.publish", schema: PublishNoticeSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ version: string; previous: string | null }>> => {
    const { data: row, error: readError } = await ctx.supabase.from("privacy_notices").select("id, body").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!row) return fail("That version no longer exists.", { code: "not_found" });
    const missing = noticeMissingTopics(row.body);
    const { data, error } = await ctx.supabase.rpc("publish_privacy_notice", { p_id: input.id, p_expected_updated_at: input.updatedAt });
    throwIfDbError(error);
    const r = (data ?? {}) as { version?: string; previous?: string | null; already?: boolean };
    const version = r.version ?? "";
    if (r.already) return ok({ version, previous: null });

    await ctx.audit({ event: "config_change", resourceType: "privacy_notice", resourceId: input.id, action: "privacy_notices.publish", details: { version, previous: r.previous ?? null } });
    ctx.after("Record it in the notice's history", () =>
      logActivity({ entityType: "privacy_notice", entityId: input.id, action: "privacy_notice_published", description: `Version ${version} published by ${ctx.user.fullName}${r.previous ? `, replacing ${r.previous}` : ""}` }),
    );
    ctx.after("Tell the other Partners", () =>
      notify({
        to: { roles: ["partner"] },
        type: "info",
        title: `Privacy notice ${version} is now in force`,
        body: `${ctx.user.fullName} published version ${version}${r.previous ? ` in place of ${r.previous}` : ""}. Portal users acknowledge it the next time they sign in.`,
        linkUrl: "/settings/data",
        entity: { type: "privacy_notice", id: input.id },
        dedupeKey: `privacy_notice_published:${input.id}`,
      }),
    );
    const warnings = missing.length ? [`The notice may not cover: ${missing.join(", ").toLowerCase()}. Check it says each of these (§6.10).`] : [];
    return ok({ version, previous: r.previous ?? null }, warnings);
  },
);

export const deleteNoticeDraft = defineAction(
  { name: "privacy_notices.delete_draft", schema: DeleteNoticeSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: row, error: readError } = await ctx.supabase.from("privacy_notices").select("id, version, published_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!row) return fail("That draft no longer exists.", { code: "not_found" });
    if (row.published_at) return fail("A published notice is kept with the acknowledgements given against it, so it can't be deleted.", { code: "blocked" });
    const { error, count } = await ctx.supabase.from("privacy_notices").delete({ count: "exact" }).eq("id", input.id).is("published_at", null);
    throwIfDbError(error);
    if (!count) return fail("That draft no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "config_change", resourceType: "privacy_notice", resourceId: input.id, action: "privacy_notices.delete_draft", details: { version: row.version } });
    return ok({ id: input.id });
  },
);

export const withdrawConsent = defineAction(
  { name: "privacy_notices.withdraw_consent", schema: ConsentWithdrawSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ withdrawnAt: string }>> => {
    const { data: row, error: readError } = await ctx.supabase.from("consent_records").select("id, subject_type, notice_version, withdrawn_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!row) return fail("That consent record no longer exists.", { code: "not_found" });
    if (row.withdrawn_at) return fail("This consent is already withdrawn.", { code: "blocked" });
    const now = new Date().toISOString();
    const { data, error } = await ctx.supabase.from("consent_records").update({ withdrawn_at: now }).eq("id", input.id).is("withdrawn_at", null).select("withdrawn_at");
    throwIfDbError(error);
    if (!data?.length) return fail("This consent was changed by someone else. Reload to see it.", { code: "conflict" });
    await ctx.audit({
      event: "data_update",
      resourceType: "consent_record",
      resourceId: input.id,
      action: "privacy_notices.withdraw_consent",
      details: { subject_type: row.subject_type, notice_version: row.notice_version, note: input.note },
    });
    return ok({ withdrawnAt: data[0].withdrawn_at ?? now });
  },
);
