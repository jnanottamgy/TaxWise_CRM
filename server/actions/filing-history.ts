"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { compareDates, todayIST } from "@/lib/domain/fy";
import { addTimelineEvent } from "@/server/timeline";
import { logEmployeeActivity } from "@/server/activity";
import { ImportFilingsSchema, RecordRefSchema, UpdateFilingSchema, serviceTypeForForm } from "@/lib/schemas/registers";
import type { Json } from "@/lib/database.types";

/**
 * Filing history (§7.15.2): every filing on record, ours or inherited from a previous CA.
 *
 *   importPriorFilings   "Import prior filings" (CSV) for a client moving from another CA: the browser
 *                        reads the file and checks each row (lib/schemas/registers.ts
 *                        checkFilingImport); the valid rows come here, are checked again, and go in
 *                        one transaction through import_filing_records (0194), which skips rows
 *                        already on record so a re-run never doubles up. Partners and Managers.
 *   updateInheritedFiling / deleteInheritedFiling
 *                        correct or remove an imported (inherited) record. Filings made by the firm
 *                        are recorded from the task or deadline they closed (§7.6.5, §7.7) and are
 *                        changed there.
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This filing record was changed by someone else. Reload to see their changes.";

export const importPriorFilings = defineAction(
  { name: "filings.import", schema: ImportFilingsSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ inserted: number; skipped: number }>> => {
    const { data: client, error: clientError } = await ctx.supabase.from("clients").select("id, display_name, deleted_at").eq("id", input.clientId).maybeSingle();
    throwIfDbError(clientError);
    if (!client || client.deleted_at) return fail("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
    const today = todayIST();
    const future = input.rows.findIndex((r) => r.filed_on && compareDates(r.filed_on, today) > 0);
    if (future >= 0) return fail(`Row ${future + 1}: the filing date is in the future.`, { code: "validation" });

    const { data, error } = await ctx.supabase.rpc("import_filing_records", { p_client_id: client.id, p_rows: input.rows as unknown as Json });
    throwIfDbError(error);
    const r = (data ?? {}) as { inserted?: number; skipped?: number };
    const inserted = r.inserted ?? 0;
    const skipped = r.skipped ?? 0;
    const firms = [...new Set(input.rows.map((x) => x.filed_by_external))];
    const years = [...new Set(input.rows.map((x) => x.financial_year))].sort();

    await ctx.audit({
      event: "data_create",
      resourceType: "filing_record",
      resourceId: client.id,
      action: "filings.import",
      details: { client_id: client.id, file: input.fileName || null, rows: input.rows.length, inserted, skipped, previous_firms: firms.slice(0, 5), years },
    });
    if (inserted > 0) {
      ctx.after("Add the import to the client's timeline", () =>
        addTimelineEvent({
          clientId: client.id,
          eventType: "filings_imported",
          title: `Prior filings imported: ${inserted} ${inserted === 1 ? "filing" : "filings"} by ${firms.slice(0, 2).join(", ")}${firms.length > 2 ? " and others" : ""}, FY ${years[0]}${years.length > 1 ? ` to ${years[years.length - 1]}` : ""}`,
          metadata: { inserted, skipped },
        }),
      );
      ctx.after("Add to your activity", () =>
        logEmployeeActivity({ activityType: "client_updated", description: `Imported ${inserted} prior filings for ${client.display_name}`, entityType: "client", entityId: client.id, entityName: client.display_name }),
      );
    }
    return ok({ inserted, skipped }, skipped > 0 ? [`${skipped} ${skipped === 1 ? "filing was" : "filings were"} already on record and left as they were.`] : undefined);
  },
);

export const updateInheritedFiling = defineAction(
  { name: "filings.update_inherited", schema: UpdateFilingSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("filing_records").select("id, client_id, filed_by_external, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That filing record no longer exists. Reload to see the history.", { code: "not_found" });
    if (!before.filed_by_external) throw new ActionError("This filing was made by the firm: change it from the task or deadline it closed.", { code: "blocked" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    if (input.filedOn && compareDates(input.filedOn, todayIST()) > 0) return fail("The filing date can't be in the future.", { code: "validation", fieldErrors: { filedOn: ["The filing date can't be in the future."] } });
    const { data, error } = await ctx.supabase
      .from("filing_records")
      .update({
        financial_year: input.financialYear,
        filing_type: input.filingType,
        service_type: serviceTypeForForm(input.filingType),
        period: input.period,
        filed_on: input.filedOn,
        acknowledgement_no: input.acknowledgementNo,
        filed_by_external: input.filedByExternal,
        notes: input.notes,
      })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    throwIfDbError(error);
    const row = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!row) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "filing_record", resourceId: row.id, details: { client_id: before.client_id, form: input.filingType, financial_year: input.financialYear } });
    ctx.after("Add the correction to the client's timeline", () =>
      addTimelineEvent({ clientId: before.client_id, eventType: "filing_record_updated", title: `Prior filing corrected: ${input.filingType}${input.period ? ` ${input.period}` : ""}, FY ${input.financialYear}`, metadata: { filing_record_id: row.id } }),
    );
    return ok({ id: row.id, updatedAt: row.updated_at });
  },
);

export const deleteInheritedFiling = defineAction(
  { name: "filings.delete_inherited", schema: RecordRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("filing_records").select("id, client_id, filing_type, period, financial_year, filed_by_external, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That filing record has already been removed.", { code: "not_found" });
    if (!before.filed_by_external) throw new ActionError("This filing was made by the firm and stays on record.", { code: "blocked" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const { count: linked, error: udinError } = await ctx.supabase.from("udin_records").select("id", { count: "exact", head: true }).eq("filing_record_id", input.id);
    throwIfDbError(udinError);
    const { data, error } = await ctx.supabase.from("filing_records").delete().eq("id", input.id).eq("updated_at", input.updatedAt).select("id");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_delete", resourceType: "filing_record", resourceId: input.id, details: { client_id: before.client_id, form: before.filing_type, period: before.period, financial_year: before.financial_year, previous_firm: before.filed_by_external } });
    ctx.after("Add the removal to the client's timeline", () =>
      addTimelineEvent({ clientId: before.client_id, eventType: "filing_record_removed", title: `Prior filing removed: ${before.filing_type}${before.period ? ` ${before.period}` : ""}, FY ${before.financial_year}`, metadata: { filing_record_id: input.id } }),
    );
    return ok({ id: input.id }, linked ? [`${linked} ${linked === 1 ? "UDIN was" : "UDINs were"} linked to it; ${linked === 1 ? "it stays" : "they stay"} in the register without the link.`] : undefined);
  },
);
