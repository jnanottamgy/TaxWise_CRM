"use server";

import { z } from "zod";
import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatINR, toPaise } from "@/lib/domain/money";
import { SubmitDraftsSchema } from "@/lib/schemas/collections";
import { getIssueTargets, listWaitingDraftIds, type IssueTarget } from "@/lib/data/collections";
import { getEmailReadiness } from "@/server/email/readiness";
import { notify } from "@/server/notify";
import { logActivity } from "@/server/activity";

/**
 * The Retainer drafts queue (§7.9.6). Partners and Managers only (§4.1).
 *
 *   prepareRetainerIssue      for "Issue selected / Issue all": each draft's current version, who it
 *                             goes to by email (the client's primary contact with a working email,
 *                             else the client's email), and whether email can go at all (§7.13.5).
 *                             The page then issues each draft through the invoices module's
 *                             issueInvoice (server/actions/invoices.ts), one at a time.
 *   submitDraftsForApproval   a Manager's drafts held over the invoice approval limit go to the
 *                             Partners (Awaiting approval, §7.9.2); Partners are told.
 */

const MONEY_ROLES = ["partner", "manager"] as const;

const PrepareSchema = z
  .object({
    /** The drafts picked in the queue; or `all` for every draft waiting (in one run, when given). */
    invoiceIds: z.array(z.uuid()).max(200, { error: "Issue at most 200 drafts at a time." }).optional().default([]),
    all: z.boolean().optional().default(false),
    runId: z
      .union([z.uuid(), z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => v.all || v.invoiceIds.length > 0, { error: "Select at least one draft.", path: ["invoiceIds"] });

export const prepareRetainerIssue = defineAction(
  { name: "retainer.prepare_issue", schema: PrepareSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ emailReady: boolean; emailReason: string | null; targets: IssueTarget[] }>> => {
    const ids = input.all ? await listWaitingDraftIds(ctx.supabase, input.runId, 200, { includeHeld: ctx.user.role === "partner" }) : input.invoiceIds;
    const [targets, readiness] = await Promise.all([getIssueTargets(ctx.supabase, ids), getEmailReadiness(ctx.supabase)]);
    if (!targets.length) throw new ActionError("None of the selected drafts is waiting any more. Reload to see the queue.", { code: "not_found" });
    return ok({ emailReady: readiness.ready, emailReason: readiness.reason, targets });
  },
);

export const submitDraftsForApproval = defineAction(
  { name: "retainer.submit_for_approval", schema: SubmitDraftsSchema, roles: MONEY_ROLES },
  async (input, ctx): Promise<ActionResult<{ submitted: number; changed: number }>> => {
    let submitted = 0;
    let changed = 0;
    const done: Array<{ id: string; total: number }> = [];
    for (const item of input.items) {
      const { data, error } = await ctx.supabase
        .from("invoices")
        .update({ status: "awaiting_approval", submitted_at: new Date().toISOString(), approval_note: null })
        .eq("id", item.invoiceId)
        .eq("updated_at", item.updatedAt)
        .eq("status", "draft")
        .eq("requires_approval", true)
        .is("approved_at", null)
        .is("deleted_at", null)
        .select("id, total_amount");
      throwIfDbError(error);
      if (data?.length) {
        submitted++;
        done.push({ id: data[0].id, total: data[0].total_amount });
      } else {
        changed++;
      }
    }
    if (!submitted) {
      throw new ActionError(
        changed === 1 ? "This draft changed since you loaded the page, or no longer needs approval. Reload to see it." : "These drafts changed since you loaded the page, or no longer need approval. Reload to see them.",
        { code: "conflict" },
      );
    }
    await ctx.audit({ event: "data_update", resourceType: "invoice", action: "retainer.submit_for_approval", details: { invoice_ids: done.map((d) => d.id), submitted, changed } });
    for (const d of done) {
      ctx.after("Add to the invoice's history", () => logActivity({ entityType: "invoice", entityId: d.id, action: "invoice_submitted", description: "Retainer draft sent to the Partners for approval" }));
    }
    const total = done.reduce((s, d) => s + toPaise(d.total), 0);
    ctx.after("Tell the Partners", () =>
      notify({
        to: { roles: ["partner"] },
        type: "invoice_awaiting_approval",
        title: submitted === 1 ? "A retainer invoice is awaiting your approval" : `${submitted} retainer invoices are awaiting your approval`,
        body: `${ctx.user.fullName} sent ${submitted === 1 ? "a retainer draft" : `${submitted} retainer drafts`} over the approval limit (${formatINR(total)} in all).`,
        linkUrl: "/invoices?status=awaiting_approval",
        entity: done.length === 1 ? { type: "invoice", id: done[0].id } : null,
      }),
    );
    return ok({ submitted, changed });
  },
);
