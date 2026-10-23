"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import type { Json } from "@/lib/database.types";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { SaveKycSchema, VerifyKycSchema, defaultNextReview, toStoredPersons } from "@/lib/schemas/client-kyc";
import { getKyc, kycCheckFor } from "@/lib/data/client360";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity } from "@/server/activity";

/**
 * KYC (§6.8 ICAI KYC Norms; Client 360 → Profile & contacts → KYC), Partner/Manager only (RLS 0033):
 * save the record for the client's category, and mark it verified (which needs it complete, and
 * sets the annual review). A full Aadhaar number is refused by the schema and again by the 0115
 * guard (§6.10). Edits carry client_kyc.updated_at (§13).
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "The KYC record was changed by someone else. Reload to see their changes.";

async function clientBrief(ctx: ActionContext, clientId: string) {
  const { data, error } = await ctx.supabase.from("clients").select("id, display_name, legal_name, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  return data && !data.deleted_at ? data : null;
}

export const saveClientKyc = defineAction(
  { name: "clients.kyc_save", schema: SaveKycSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string; complete: boolean; missing: string[] }>> => {
    const client = await clientBrief(ctx, input.clientId);
    if (!client) return fail("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });

    if (input.lastAuditedFsDocumentId) {
      const { data: doc, error: docError } = await ctx.supabase.from("documents").select("id, client_id, deleted_at").eq("id", input.lastAuditedFsDocumentId).maybeSingle();
      throwIfDbError(docError);
      if (!doc || doc.client_id !== input.clientId || doc.deleted_at) {
        return fail("Choose one of this client's documents.", { code: "validation", fieldErrors: { lastAuditedFsDocumentId: ["Choose one of this client's documents."] } });
      }
    }

    const values = {
      entity_category: input.entityCategory,
      pan: input.pan,
      cin_llpin: input.cinLlpin,
      business_description: input.businessDescription,
      registered_address: input.registeredAddress,
      last_audited_fs_document_id: input.lastAuditedFsDocumentId,
      engagement_types: input.engagementTypes.length ? input.engagementTypes : null,
      principal_persons: toStoredPersons(input.principalPersons) as unknown as Json,
      next_review_on: input.nextReviewOn,
    };

    const existing = await getKyc(ctx.supabase, input.clientId);
    let saved: { id: string; updated_at: string } | undefined;
    if (existing) {
      if (!input.updatedAt || existing.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
      const { data, error } = await ctx.supabase.from("client_kyc").update(values).eq("id", existing.id).eq("updated_at", input.updatedAt).select("id, updated_at");
      throwIfDbError(error);
      saved = (data ?? [])[0] as typeof saved;
      if (!saved) return fail(STALE, { code: "conflict" });
    } else {
      const { data, error } = await ctx.supabase.from("client_kyc").insert({ client_id: input.clientId, ...values }).select("id, updated_at").single();
      throwIfDbError(error, { uniqueMessage: STALE });
      saved = data as { id: string; updated_at: string };
    }

    const after = await getKyc(ctx.supabase, input.clientId);
    const check = kycCheckFor(client, after, todayIST());
    await ctx.audit({
      event: existing ? "data_update" : "data_create",
      resourceType: "client_kyc",
      resourceId: saved.id,
      details: { client_id: input.clientId, category: input.entityCategory, persons: input.principalPersons.length, complete: check.complete },
    });
    ctx.after("Add the KYC update to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: existing ? "kyc_updated" : "kyc_created",
        title: check.complete ? "KYC details saved: complete" : `KYC details saved: ${check.missing.length} item${check.missing.length === 1 ? "" : "s"} still missing`,
        metadata: { complete: check.complete },
      }),
    );
    return ok({ id: saved.id, updatedAt: saved.updated_at, complete: check.complete, missing: check.missing });
  },
);

export const verifyClientKyc = defineAction(
  { name: "clients.kyc_verify", schema: VerifyKycSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; nextReviewOn: string }>> => {
    const client = await clientBrief(ctx, input.clientId);
    if (!client) return fail("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
    const kyc = await getKyc(ctx.supabase, input.clientId);
    if (!kyc) return fail("Save the KYC details first.", { code: "blocked" });
    if (kyc.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });

    const verifiedOn = input.verifiedOn as string;
    const today = todayIST();
    if (verifiedOn > today) return fail("The verification date can't be in the future.", { code: "validation", fieldErrors: { verifiedOn: ["The verification date can't be in the future."] } });
    const nextReviewOn = input.nextReviewOn ?? defaultNextReview(verifiedOn);
    if (nextReviewOn <= verifiedOn) return fail("The next review must be after the verification date.", { code: "validation", fieldErrors: { nextReviewOn: ["Choose a date after the verification date."] } });

    const check = kycCheckFor(client, kyc, today);
    if (!check.complete) return fail(`KYC isn't complete yet: ${check.missing.join(", ")} missing. Fill those in, then verify.`, { code: "blocked" });

    const { data, error } = await ctx.supabase
      .from("client_kyc")
      .update({ verified_by: ctx.user.id, verified_on: verifiedOn, next_review_on: nextReviewOn })
      .eq("id", kyc.id)
      .eq("updated_at", input.updatedAt)
      .select("updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { updated_at: string } | undefined;
    if (!saved) return fail(STALE, { code: "conflict" });

    await ctx.audit({ event: "data_update", resourceType: "client_kyc", resourceId: kyc.id, action: "clients.kyc_verify", details: { client_id: input.clientId, verified_on: verifiedOn, next_review_on: nextReviewOn } });
    ctx.after("Add the verification to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "kyc_verified",
        title: `KYC verified on ${formatDate(verifiedOn)}; next review ${formatDate(nextReviewOn)}`,
      }),
    );
    ctx.after("Record the verification in the KYC history", () =>
      logActivity({ entityType: "client_kyc", entityId: kyc.id, action: "kyc_verified", description: `Verified on ${formatDate(verifiedOn)}` }),
    );
    return ok({ updatedAt: saved.updated_at, nextReviewOn });
  },
);
