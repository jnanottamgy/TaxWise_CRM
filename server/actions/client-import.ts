"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import type { Json } from "@/lib/database.types";
import { ImportRowsSchema, checkImportRows, importLookups, type RawImportRow } from "@/lib/schemas/clients";
import { getImportContext } from "@/lib/data/clients";
import { logEmployeeActivity } from "@/server/activity";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * CSV import of clients (§7.3.4): the row-level validation report (invalid PAN/GSTIN, duplicate
 * code, PAN or GSTIN — in the file or already in the firm, recycled clients included — unknown
 * owner, unknown group …), then "import valid rows only". The file is read in the browser
 * (papaparse) and mapped to the import columns; both steps re-check every row here against the
 * database, and `import_clients` (0113) saves each row in its own savepoint. Partner/Manager.
 */

const PM = ["partner", "manager"] as const;

export type ImportReportRow = { row: number; name: string; ok: boolean; errors: string[]; warnings: string[] };

async function check(supabase: ServerSupabase, rows: RawImportRow[]) {
  const ctx = await getImportContext(supabase, importLookups(rows));
  return checkImportRows(rows, ctx);
}

export const previewClientImport = defineAction(
  { name: "clients.import.preview", schema: ImportRowsSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ report: ImportReportRow[]; valid: number; invalid: number }>> => {
    const checks = await check(ctx.supabase, input.rows as RawImportRow[]);
    const report = checks.map((c) => ({ row: c.row, name: c.name, ok: c.value !== null, errors: c.errors, warnings: c.warnings }));
    const valid = report.filter((r) => r.ok).length;
    return ok({ report, valid, invalid: report.length - valid });
  },
);

export type ImportOutcome = {
  imported: number;
  failed: number;
  skipped: number;
  results: Array<{ row: number; name: string; ok: boolean; clientId?: string; clientCode?: string; error?: string }>;
};

export const importClients = defineAction(
  { name: "clients.import", schema: ImportRowsSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<ImportOutcome>> => {
    const checks = await check(ctx.supabase, input.rows as RawImportRow[]);
    const valid = checks.filter((c) => c.value !== null);
    if (valid.length === 0) return fail("None of the rows can be imported. Fix the problems in the report and try again.", { code: "validation" });
    const { data, error } = await ctx.supabase.rpc("import_clients", {
      p_rows: valid.map((c) => c.value) as unknown as Json,
      p_meta: { ip: ctx.ip, user_agent: ctx.userAgent, file_name: input.fileName ?? null },
    });
    throwIfDbError(error);
    const res = data as { imported: number; failed: number; results: Array<{ row: number; ok: boolean; client_id?: string; client_code?: string; error?: string }> };
    const byRow = new Map(res.results.map((r) => [r.row, r]));
    const results: ImportOutcome["results"] = checks.map((c) => {
      const r = byRow.get(c.row);
      if (!c.value) return { row: c.row, name: c.name, ok: false, error: c.errors[0] ?? "This row has problems." };
      if (!r) return { row: c.row, name: c.name, ok: false, error: "This row wasn't saved." };
      return r.ok ? { row: c.row, name: c.name, ok: true, clientId: r.client_id, clientCode: r.client_code } : { row: c.row, name: c.name, ok: false, error: r.error };
    });
    if (res.imported > 0) {
      ctx.after("Log the activity", () =>
        logEmployeeActivity({ activityType: "client_created", description: `Imported ${res.imported} ${res.imported === 1 ? "client" : "clients"} from ${input.fileName ?? "a CSV file"}` }),
      );
    }
    return ok({ imported: res.imported, failed: res.failed, skipped: checks.length - valid.length, results });
  },
);
