"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { DeletePeerReviewSchema, PeerReviewSchema } from "@/lib/schemas/quality";
import { notify } from "@/server/notify";

/**
 * Peer review records (Peer Review Guidelines 2022, §6.8): period, reviewer, certificate number and
 * validity. Partners only (§4.1 "peer review read-only" for Managers; RLS 0037). A completed review
 * needs its certificate, review date and validity (0197 guard); the certificate valid on the
 * acceptance date opens audits that need a peer-reviewed auditor (0196), and the reminders job
 * warns 90 days before it expires.
 */

const STALE = "This peer review was changed by someone else. Reload to see their changes.";

export const savePeerReview = defineAction(
  { name: "peer_reviews.save", schema: PeerReviewSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    if (input.reviewedOn && input.reviewedOn > todayIST()) return fail("The review date can't be in the future.", { code: "validation", fieldErrors: { reviewedOn: ["Pick today or an earlier date."] } });
    const values = {
      period_from: input.periodFrom,
      period_to: input.periodTo,
      reviewer_name: input.reviewerName,
      reviewer_frn: input.reviewerFrn,
      status: input.status,
      reviewed_on: input.reviewedOn,
      certificate_no: input.certificateNo,
      valid_until: input.validUntil,
      observations: input.observations,
      notes: input.notes,
    };
    let row: { id: string; updated_at: string };
    const created = !input.id;
    if (input.id) {
      if (!input.updatedAt) return fail(STALE, { code: "conflict" });
      const { data, error } = await ctx.supabase.from("peer_reviews").update(values).eq("id", input.id).eq("updated_at", input.updatedAt).select("id, updated_at");
      if (error?.message?.startsWith("USER: ")) throw new ActionError(error.message.slice(6));
      throwIfDbError(error);
      if (!data?.length) return fail(STALE, { code: "conflict" });
      row = data[0];
    } else {
      const { data, error } = await ctx.supabase.from("peer_reviews").insert(values).select("id, updated_at").single();
      if (error?.message?.startsWith("USER: ")) throw new ActionError(error.message.slice(6));
      throwIfDbError(error);
      row = data!;
    }
    await ctx.audit({ event: created ? "data_create" : "data_update", resourceType: "peer_review", resourceId: row.id, details: { status: input.status, certificate_no: input.certificateNo, valid_until: input.validUntil } });
    if (input.status === "completed" && input.validUntil) {
      ctx.after("Tell the Partners", () =>
        notify({
          to: { roles: ["partner", "manager"] },
          type: "info",
          title: "Peer review certificate recorded",
          body: `Certificate ${input.certificateNo ?? ""} from ${input.reviewerName}, valid until ${formatDate(input.validUntil!)}.`.replace("  ", " "),
          linkUrl: "/quality?tab=peer-reviews",
          entity: { type: "peer_review", id: row.id },
          dedupeKey: `peer_review_recorded:${row.id}:${input.validUntil}`,
        }),
      );
    }
    return ok({ id: row.id, updatedAt: row.updated_at });
  },
);

export const deletePeerReview = defineAction(
  { name: "peer_reviews.delete", schema: DeletePeerReviewSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: row, error: readError } = await ctx.supabase.from("peer_reviews").select("id, reviewer_name, certificate_no").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!row) return fail("That peer review no longer exists.", { code: "not_found" });
    const { error } = await ctx.supabase.from("peer_reviews").delete().eq("id", input.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "peer_review", resourceId: input.id, details: { reviewer_name: row.reviewer_name, certificate_no: row.certificate_no } });
    return ok({ id: input.id });
  },
);
