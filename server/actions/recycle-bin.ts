"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ok, fail, type ActionResult } from "@/lib/result";
import { formatNumber } from "@/lib/format";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity } from "@/server/activity";
import { removeStoredObjects } from "@/server/files";
import { BIN_ENTITIES, BIN_ENTITY_LABEL, binItemHref, purgeConfirmPhrase, purgeConfirmed, type BinEntity } from "@/components/recycle-bin/entities";

/**
 * The recycle bin's two writes (§7.19, §4.1).
 *
 *   restoreFromBin   Partner / Manager: restore_deleted (0211) puts the record back; a client brings
 *                    back the tasks, documents, invoices and WhatsApp groups deleted with it.
 *                    Children wait for their client (and a quotation for its lead).
 *   purgeFromBin     Partner only, after typing the record's code (or PURGE): purge_deleted deletes
 *                    it for good once nothing keeps it (retention dates, the GST record-keeping
 *                    period, receipts and credit notes, a client's registers; §6.8). The files go
 *                    from the vault after the commit.
 *
 * Both carry the updated_at the bin showed (optimistic concurrency, §13), write an audit row, and
 * add the event to the record's history and the client's timeline after the save (§0.1 rules 5, 12).
 * Money-side records (invoices, quotations, leads) are recorded with money-side event types, which
 * Employees never see (§4.1); the timeline never names invoice counts.
 */

const PM = ["partner", "manager"] as const;

const ItemSchema = z.object({
  entity: z.enum(BIN_ENTITIES, { error: "That kind of record isn't kept in the recycle bin." }),
  id: z.uuid({ error: "That record isn't in the recycle bin." }),
  updatedAt: z.string().min(1, { error: "Reload the recycle bin and try again." }),
});

const PurgeSchema = ItemSchema.extend({
  confirm: z.string().max(200),
});

type RestoreResult = {
  entity: BinEntity;
  id: string;
  label: string;
  client_id: string | null;
  lead_id: string | null;
  tasks: number;
  documents: number;
  invoices: number;
  whatsapp_groups: number;
};

type PurgeResult = {
  entity: BinEntity;
  id: string;
  label: string;
  client_id: string | null;
  lead_id: string | null;
  storage_paths: string[];
  counts: Record<string, number>;
};

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** "with 3 tasks and 12 documents" for a restored client (invoices stay out of the timeline, §4.1). */
function withChildren(r: Pick<RestoreResult, "tasks" | "documents">): string | null {
  const parts = [r.tasks ? plural(r.tasks, "task", "tasks") : null, r.documents ? plural(r.documents, "document", "documents") : null].filter(Boolean);
  return parts.length ? `With ${parts.join(" and ")}.` : null;
}

async function binRow(ctx: ActionContext, entity: BinEntity, id: string) {
  const { data, error } = await ctx.supabase.from("recycle_bin_items").select("entity, id, title, reference, client_id, lead_id").eq("entity", entity).eq("id", id).maybeSingle();
  throwIfDbError(error);
  return data;
}

export const restoreFromBin = defineAction(
  { name: "recycle_bin.restore", schema: ItemSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ entity: BinEntity; id: string; label: string; href: string; summary: string }>> => {
    const { data, error } = await ctx.supabase.rpc("restore_deleted", { p_entity: input.entity, p_id: input.id, p_updated_at: input.updatedAt });
    throwIfDbError(error);
    const r = data as unknown as RestoreResult;

    await ctx.audit({
      event: "data_update",
      resourceType: input.entity,
      resourceId: input.id,
      action: "recycle_bin.restore",
      details: {
        label: r.label,
        before: { deleted: true },
        after: { deleted: false },
        restored_with: input.entity === "client" ? { tasks: r.tasks, documents: r.documents, invoices: r.invoices, whatsapp_groups: r.whatsapp_groups } : undefined,
      },
    });

    const what = BIN_ENTITY_LABEL[input.entity].one.toLowerCase();
    const title = `Restored from the recycle bin: ${r.label}`;
    if (r.client_id || r.lead_id) {
      ctx.after("Add the restore to the timeline", () =>
        addTimelineEvent({
          clientId: r.client_id,
          leadId: input.entity === "lead" || input.entity === "quotation" ? r.lead_id : null,
          eventType: `${input.entity}_restored`,
          title,
          description: input.entity === "client" ? withChildren(r) : null,
          metadata: { [`${input.entity}_id`]: input.id },
        }),
      );
    }
    ctx.after("Record the restore in its history", () =>
      logActivity({ entityType: input.entity, entityId: input.id, action: `${input.entity}_restored`, description: `Restored from the recycle bin by ${ctx.user.fullName}` }),
    );

    const summary =
      input.entity === "client" && (r.tasks || r.documents || r.invoices)
        ? `${r.label} is back, with ${[r.tasks ? plural(r.tasks, "task", "tasks") : null, r.documents ? plural(r.documents, "document", "documents") : null, r.invoices ? plural(r.invoices, "invoice", "invoices") : null].filter(Boolean).join(", ")}.`
        : `The ${what} ${r.label} is back.`;
    return ok({ entity: input.entity, id: input.id, label: r.label, href: binItemHref(input.entity, input.id, r.client_id), summary });
  },
);

export const purgeFromBin = defineAction(
  { name: "recycle_bin.purge", schema: PurgeSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ entity: BinEntity; id: string; label: string }>> => {
    const row = await binRow(ctx, input.entity, input.id);
    if (!row) return fail("That record isn't in the recycle bin any more. Reload to see the latest.", { code: "not_found" });
    const phrase = purgeConfirmPhrase({ entity: input.entity, reference: row.reference, title: row.title ?? "" });
    if (!purgeConfirmed(input.confirm, phrase)) {
      return fail(`Type ${phrase} to confirm the purge.`, { code: "validation", fieldErrors: { confirm: [`Type ${phrase} exactly.`] } });
    }

    const { data, error } = await ctx.supabase.rpc("purge_deleted", { p_entity: input.entity, p_id: input.id, p_updated_at: input.updatedAt });
    throwIfDbError(error);
    const r = data as unknown as PurgeResult;

    await ctx.audit({
      event: "data_delete",
      resourceType: input.entity,
      resourceId: input.id,
      action: "recycle_bin.purge",
      details: { label: r.label, purged: true, client_id: r.client_id, counts: r.counts, files: (r.storage_paths ?? []).length },
    });

    const paths = r.storage_paths ?? [];
    if (paths.length) {
      ctx.after(
        "Remove the files from the vault",
        async () => {
          for (let i = 0; i < paths.length; i += 500) await removeStoredObjects(paths.slice(i, i + 500));
        },
        "The record is purged, but its files couldn't all be removed from storage. They can no longer be opened.",
      );
    }
    if (input.entity !== "client" && input.entity !== "lead" && (r.client_id || r.lead_id)) {
      ctx.after("Add the purge to the client's timeline", () =>
        addTimelineEvent({
          clientId: r.client_id,
          leadId: input.entity === "quotation" ? r.lead_id : null,
          eventType: `${input.entity}_purged`,
          title: `Deleted permanently from the recycle bin: ${r.label}`,
        }),
      );
    }
    return ok({ entity: input.entity, id: input.id, label: r.label });
  },
);
