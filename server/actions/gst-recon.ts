"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult, type FieldErrors } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { parseGstr2b, parseRegisterRows, mapColumns, validateColumnMapping, REGISTER_FIELD_SPECS, totalTax, type GstDocRow, type MappingSuggestion, type RegisterField } from "@/lib/domain/gstr2b";
import { amountDeltas, carryForward, reconcile, type CarryForwardResult, type OpenItem, type ReconEntry } from "@/lib/domain/recon";
import type { Json } from "@/lib/database.types";
import type { ComboOption } from "@/components/app/form/combobox";
import { previewRows } from "@/components/workpapers/shared/sheet";
import {
  ClientSearchSchema,
  GSTR2B_PATH_PATTERN,
  ImsDecisionSchema,
  InspectSheetSchema,
  PrepareGstr2bUploadSchema,
  ResolveLinesSchema,
  RunLookupSchema,
  RunReconSchema,
  RunRefSchema,
  SupplierFollowedUpSchema,
  SupplierLinesSchema,
  compactDoc,
  entryData,
  openItemFromLine,
  periodLabel,
  supplierMissingItems,
  type RegisterMapping,
  type StoredRunSummary,
} from "@/lib/schemas/gst-recon";
import {
  SourceFileError,
  decisionsOfRun,
  followUpLines,
  getReconClient,
  getRunDetail,
  inspectVaultSheet,
  latestRunOf,
  openLinesForCarryForward,
  previousRunOf,
  readGstr2bFile,
  rememberedMapping,
  savedColumns,
  searchWorkpaperClients,
  type ReconClient,
} from "@/lib/data/gst-recon";
import { createSignedDownload } from "@/server/files";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * GST reconciliation (§6.12, §7.8.1). Any staff member who can see the client (Employees: their own
 * clients, §4.1); RLS and the database functions of 0200–0201 are the real control.
 *
 *   prepareGstr2bUpload    a signed upload URL for the GSTR-2B JSON in task-files/<client>/gstr2b/
 *                          (the document vault takes no JSON files)
 *   inspectRegister        reads the purchase register from the client's vault: sheets, the header
 *                          row, a preview and the suggested column mapping (remembered per client)
 *   runGstRecon            reads both stored files back, parses (lib/domain/gstr2b.ts), reconciles
 *                          (lib/domain/recon.ts), carries last month's open lines forward and saves
 *                          the run with every line in one transaction (save_gst_recon_run). The
 *                          results are always computed here, never taken from the browser.
 *   resolveReconLines      mark lines settled / following up / ignored / open with a note
 *   decideImsAction        accept / reject / keep pending a 2B document, with the reason
 *   supplierFollowUp       the lines to put in a supplier follow-up draft (§7.13.2)
 *   markSupplierFollowedUp after a WhatsApp hand-off, the supplier's open lines are "Following up"
 *   gstr2bSourceUrl        a 60-second link to the stored GSTR-2B file
 *
 * Every mutation writes an audit row; the client timeline and the person's activity follow in
 * ctx.after (§0.1 rule 5). Nothing here is fee data.
 */

const STAFF = STAFF_ROLES;

/** DB errors, with the concurrency refusal ("Changed by … at …") as a conflict (§13). */
function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

async function clientOrFail(ctx: ActionContext, clientId: string): Promise<ReconClient> {
  const client = await getReconClient(ctx.supabase, clientId);
  if (!client) throw new ActionError("That client isn't one of yours, or it is in the recycle bin.", { code: "not_found" });
  return client;
}

// =================================================================================================
// Lookups
// =================================================================================================

export const searchReconClients = defineAction(
  { name: "gst_recon.search_clients", schema: ClientSearchSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchWorkpaperClients(ctx.supabase, input.q)),
);

export type ReconContext = {
  client: { id: string; name: string; code: string; gstin: string | null; gstRegistration: string };
  latest: { id: string; createdAt: string; createdByName: string | null; openCount: number } | null;
  previous: { id: string; period: string; openCount: number } | null;
};

/** What the wizard shows once client and month are chosen: the GSTIN, an earlier run, what carries forward. */
export const getReconContext = defineAction(
  { name: "gst_recon.context", schema: RunLookupSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<ReconContext>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const [latest, previous] = await Promise.all([latestRunOf(ctx.supabase, client.id, input.period), previousRunOf(ctx.supabase, client.id, input.period)]);
    return ok({
      client: { id: client.id, name: client.name, code: client.code, gstin: client.gstin, gstRegistration: client.gstRegistration },
      latest: latest ? { id: latest.id, createdAt: latest.created_at, createdByName: latest.created_by_name, openCount: latest.open_count } : null,
      previous: previous ? { id: previous.id, period: previous.period, openCount: previous.open_count } : null,
    });
  },
);

// =================================================================================================
// Files
// =================================================================================================

export type PreparedUpload = { path: string; signedUrl: string; token: string };

/** A signed upload URL for the GSTR-2B JSON, issued as the caller after the client check (§12). */
export const prepareGstr2bUpload = defineAction(
  { name: "gst_recon.prepare_gstr2b_upload", schema: PrepareGstr2bUploadSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<PreparedUpload>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const path = `${client.id}/gstr2b/${globalThis.crypto.randomUUID()}.json`;
    const { data, error } = await ctx.supabase.storage.from("task-files").createSignedUploadUrl(path);
    if (error || !data) {
      return fail("Couldn't prepare the upload. Try again in a moment.", { fieldErrors: { gstr2b: ["Couldn't prepare the upload. Try again in a moment."] } });
    }
    return ok({ path, signedUrl: data.signedUrl, token: data.token });
  },
);

export type InspectedRegister = {
  documentId: string;
  fileName: string;
  sheets: string[];
  sheet: string | null;
  headerRow: number;
  headers: string[];
  preview: string[][];
  rowCount: number;
  truncated: boolean;
  suggestion: MappingSuggestion<RegisterField>;
  /** True when the suggestion started from this client's remembered columns. */
  remembered: boolean;
};

/** The purchase register's columns and the suggested mapping (§7.8.1 step 3, remembered per client). */
export const inspectRegister = defineAction(
  { name: "gst_recon.inspect_register", schema: InspectSheetSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<InspectedRegister>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const saved = savedColumns(await rememberedMapping(ctx.supabase, client.id, "purchase_register"));
    let sheet;
    try {
      sheet = await inspectVaultSheet(
        ctx.supabase,
        { clientId: client.id, documentId: input.documentId, sheet: input.sheet ?? saved.sheet, headerRow: input.headerRow ?? null },
        REGISTER_FIELD_SPECS,
      );
    } catch (err) {
      if (err instanceof SourceFileError) return fail(err.message, { fieldErrors: { register: [err.message] } });
      throw err;
    }
    const suggestion = mapColumns(sheet.records.headers, saved.columns as Partial<Record<RegisterField, string | null>> | null);
    return ok({
      documentId: sheet.documentId,
      fileName: sheet.fileName,
      sheets: sheet.sheets,
      sheet: sheet.sheet,
      headerRow: sheet.records.headerRow,
      headers: sheet.records.headers,
      preview: previewRows(sheet.records),
      rowCount: sheet.records.rowCount,
      truncated: sheet.records.truncated,
      suggestion,
      remembered: Boolean(saved.columns),
    });
  },
);

/** A 60-second link to a run's stored GSTR-2B file, signed as the caller (Storage RLS applies). */
export const gstr2bSourceUrl = defineAction(
  { name: "gst_recon.gstr2b_source_url", schema: RunRefSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ url: string }>> => {
    const detail = await getRunDetail(ctx.supabase, input.runId);
    if (!detail) return fail("That reconciliation no longer exists, or isn't one of yours.", { code: "not_found" });
    const src = detail.sources.gstr2b;
    if (!src) return fail("This run has no stored GSTR-2B file.", { code: "not_found" });
    try {
      const url = await createSignedDownload({ bucket: "task-files", path: src.path, downloadName: src.fileName }, ctx.supabase);
      await ctx.audit({ event: "file_download", resourceType: "gst_recon_run", resourceId: input.runId, details: { client_id: detail.run.client_id, file: "gstr2b", file_name: src.fileName } });
      return ok({ url });
    } catch {
      return fail("The GSTR-2B file isn't available any more.", { code: "not_found" });
    }
  },
);

// =================================================================================================
// Run (§7.8.1 step 4)
// =================================================================================================

const MAX_DIAGNOSTICS = 300;
const MAX_ISSUES = 500;

function prefixed(errors: FieldErrors, prefix: string): FieldErrors {
  return Object.fromEntries(Object.entries(errors).map(([k, v]) => [`${prefix}.${k}`, v]));
}

const CARRIED_PREFIX = "carried|";

function carriedNote(item: OpenItem, monthsOpen: number | null): string {
  const since = periodLabel(item.firstSeenPeriod);
  const age = monthsOpen && monthsOpen > 0 ? ` (open ${monthsOpen} ${monthsOpen === 1 ? "month" : "months"})` : "";
  if (item.bucket === "missing_in_2b") return `Booked in ${since} and still not in GSTR-2B${age}. Follow up with the supplier.`;
  if (item.bucket === "missing_in_books") return `In GSTR-2B for ${since} and still not booked${age}. Book it, or reject it on the IMS if it isn't the client's purchase.`;
  return `The difference from ${since} is still open${age}. Confirm the right figures with the supplier.`;
}

function carriedData(item: OpenItem, monthsOpen: number | null): Record<string, unknown> {
  const portal = item.portal as GstDocRow | null;
  const books = item.books as GstDocRow | null;
  return {
    portal: portal ? compactDoc(portal) : null,
    books: books ? compactDoc(books) : null,
    deltas: portal && books ? amountDeltas(portal, books) : null,
    dateDeltaDays: null,
    itc: { portal: portal ? totalTax(portal) : 0, books: books ? totalTax(books) : 0 },
    notes: [carriedNote(item, monthsOpen)],
    carried: { monthsOpen },
  };
}

type EntryPayload = {
  entry_key: string;
  bucket: string;
  match_tier: string | null;
  supplier_gstin: string;
  supplier_name: string | null;
  data: Record<string, unknown>;
  resolution: string;
  resolution_note: string | null;
  ims_action: string | null;
  ims_reason: string | null;
  origin: "current" | "carried";
  first_seen_period: string;
};

export type RunResult = { id: string; entries: number; carried: number; cleared: number; warnings: string[] };

export const runGstRecon = defineAction(
  { name: "gst_recon.run", schema: RunReconSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<RunResult>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const pathMatch = GSTR2B_PATH_PATTERN.exec(input.gstr2b.path);
    if (!pathMatch || pathMatch[1] !== client.id) {
      return fail("Upload the GSTR-2B JSON for this client again.", { code: "validation", fieldErrors: { gstr2b: ["Upload the GSTR-2B JSON for this client again."] } });
    }

    // 1. The GSTR-2B JSON, read back from storage and parsed here.
    let text: string;
    try {
      text = await readGstr2bFile(ctx.supabase, input.gstr2b.path);
    } catch (err) {
      if (err instanceof SourceFileError) return fail(err.message, { code: "validation", fieldErrors: { gstr2b: [err.message] } });
      throw err;
    }
    const portal = parseGstr2b(text);
    if (!portal.ok) {
      const msg = portal.diagnostics.find((d) => d.level === "error")?.message ?? "This file doesn't look like a GSTR-2B download.";
      return fail(msg, { code: "validation", fieldErrors: { gstr2b: [msg] } });
    }
    if (portal.period && portal.period !== input.period) {
      const msg = `This GSTR-2B is for ${periodLabel(portal.period)}, but you chose ${periodLabel(input.period)}. Choose ${periodLabel(portal.period)}, or upload the file for ${periodLabel(input.period)}.`;
      return fail(msg, { code: "validation", fieldErrors: { period: [msg] } });
    }

    // 2. The purchase register, read back from the vault with the confirmed mapping.
    let sheet;
    try {
      sheet = await inspectVaultSheet(ctx.supabase, { clientId: client.id, documentId: input.register.documentId, sheet: input.register.sheet, headerRow: input.register.headerRow }, REGISTER_FIELD_SPECS);
    } catch (err) {
      if (err instanceof SourceFileError) return fail(err.message, { code: "validation", fieldErrors: { register: [err.message] } });
      throw err;
    }
    const mapping = input.mapping as RegisterMapping;
    const mappingErrors = validateColumnMapping(mapping, sheet.records.headers, REGISTER_FIELD_SPECS);
    if (mappingErrors) return fail("Check the column mapping.", { code: "validation", fieldErrors: prefixed(mappingErrors, "mapping") });
    const books = parseRegisterRows(sheet.records.rows, mapping, { firstRowNumber: sheet.records.firstRowNumber });
    if (books.rows.length === 0 && books.counts.rejected > 0) {
      const first = books.issues.find((i) => i.level === "error");
      const msg = `None of the register's rows could be read${first ? `: row ${first.row}, ${first.message}` : "."} Check the column mapping.`;
      return fail(msg, { code: "validation", fieldErrors: { register: [msg] } });
    }
    if (books.rows.length === 0 && portal.rows.length === 0) {
      return fail("Neither file has any documents to reconcile. Check that you uploaded the right month.", { code: "validation" });
    }

    // 3. Reconcile (§6.12).
    const result = reconcile(portal.rows, books.rows, { clientGstin: client.gstin, portalGstin: portal.gstin });

    // 4. Carry forward last month's open lines, and keep the decisions of an earlier run of this month.
    const [previous, sameMonth] = await Promise.all([previousRunOf(ctx.supabase, client.id, input.period), latestRunOf(ctx.supabase, client.id, input.period)]);
    let carry: CarryForwardResult | null = null;
    const prevLineIdByKey = new Map<string, string>();
    if (previous) {
      const lines = await openLinesForCarryForward(ctx.supabase, previous.id, client.id, input.period);
      const items: OpenItem[] = [];
      for (const l of lines) {
        const item = openItemFromLine(l, previous.period);
        if (!item) continue;
        items.push(item);
        prevLineIdByKey.set(item.key, l.id);
      }
      carry = carryForward(items, result, input.period);
    }
    const prior = sameMonth ? await decisionsOfRun(ctx.supabase, sameMonth.id) : new Map();

    const imsByKey = new Map(result.ims.map((i) => [i.entryKey, i]));
    const clearedByKey = new Map((carry?.cleared ?? []).map((c) => [c.entryKey, c]));
    const carriedNoteText = (note: string | null) => (note ? `From the earlier run of ${periodLabel(input.period)}: ${note}`.slice(0, 1000) : `Carried from the earlier run of ${periodLabel(input.period)}.`);

    const entries: EntryPayload[] = result.entries.map((e: ReconEntry) => {
      const ims = imsByKey.get(e.key);
      const cleared = clearedByKey.get(e.key);
      const decision = prior.get(e.key);
      let resolution = "open";
      let note: string | null = null;
      if (e.bucket !== "matched") {
        if (decision && decision.bucket === e.bucket && decision.resolution !== "open") {
          resolution = decision.resolution;
          note = carriedNoteText(decision.resolution_note);
        } else if (cleared && cleared.amountsAgree) {
          resolution = "accepted";
          note = cleared.message.slice(0, 1000);
        }
      }
      const keptIms = decision && decision.bucket === e.bucket && decision.ims_decided && decision.ims_action;
      return {
        entry_key: e.key,
        bucket: e.bucket,
        match_tier: e.tier,
        supplier_gstin: e.supplierGstin,
        supplier_name: e.supplierName,
        data: entryData(e, {
          cleared: cleared ? { firstSeenPeriod: cleared.item.firstSeenPeriod, message: cleared.message, amountsAgree: cleared.amountsAgree, tier: cleared.tier } : null,
        }),
        resolution,
        resolution_note: note,
        ims_action: keptIms ? decision.ims_action : (ims?.action ?? null),
        ims_reason: keptIms ? `Decided on the earlier run of ${periodLabel(input.period)}: ${decision.ims_reason ?? ""}`.slice(0, 1000) : (ims?.reason ?? null),
        origin: "current",
        first_seen_period: cleared ? cleared.item.firstSeenPeriod : input.period,
      };
    });

    for (const item of carry?.stillOpen ?? []) {
      const key = `${CARRIED_PREFIX}${item.key.startsWith(CARRIED_PREFIX) ? item.key.slice(CARRIED_PREFIX.length) : item.key}`;
      const decision = prior.get(key);
      const keep = decision && decision.bucket === item.bucket && decision.resolution !== "open";
      entries.push({
        entry_key: key,
        bucket: item.bucket,
        match_tier: null,
        supplier_gstin: item.supplierGstin,
        supplier_name: item.supplierName,
        data: carriedData(item, item.monthsOpen),
        resolution: keep ? decision.resolution : "open",
        resolution_note: keep ? carriedNoteText(decision.resolution_note) : null,
        ims_action: null,
        ims_reason: null,
        origin: "carried",
        first_seen_period: item.firstSeenPeriod,
      });
    }

    const clearPrevious = (carry?.cleared ?? [])
      .map((c) => ({ entry_id: prevLineIdByKey.get(c.item.key) ?? null, note: `Cleared in the ${periodLabel(input.period)} reconciliation: ${c.message}`.slice(0, 1000) }))
      .filter((c) => c.entry_id);

    const summary: StoredRunSummary = {
      version: 1,
      summary: {
        buckets: Object.fromEntries(
          Object.entries(result.summary.buckets).map(([k, b]) => [k, { count: b.count, portalItc: b.portalItc, booksItc: b.booksItc }]),
        ) as StoredRunSummary["summary"]["buckets"],
        byTier: result.summary.byTier,
        documents: result.summary.documents,
        itc: result.summary.itc,
      },
      suppliers: result.suppliers.map((s) => ({
        supplierGstin: s.supplierGstin,
        supplierName: s.supplierName,
        counts: s.counts,
        itcAtRisk: s.itcAtRisk,
        unclaimedItc: s.unclaimedItc,
        mismatchDifference: s.mismatchDifference,
        chase: s.chase,
      })),
      warnings: result.warnings,
      gstr2b: { gstin: portal.gstin, period: portal.period, generatedOn: portal.generatedOn, counts: portal.counts, documents: portal.rows.length },
      register: { ...books.counts, fileName: sheet.fileName, sheet: sheet.sheet },
      carryForward: previous && carry ? { fromRunId: previous.id, fromPeriod: previous.period, cleared: carry.cleared.length, stillOpen: carry.stillOpen.length } : null,
    };

    const payload = {
      client_id: client.id,
      period: input.period,
      portal_gstin: portal.gstin,
      previous_run_id: previous?.id ?? null,
      register_document_id: sheet.documentId,
      summary,
      diagnostics: {
        gstr2b: portal.diagnostics.slice(0, MAX_DIAGNOSTICS),
        register: books.issues.slice(0, MAX_ISSUES),
        truncated: { gstr2b: Math.max(0, portal.diagnostics.length - MAX_DIAGNOSTICS), register: Math.max(0, books.issues.length - MAX_ISSUES) },
      },
      source_files: {
        gstr2b: { bucket: "task-files", path: input.gstr2b.path, fileName: input.gstr2b.fileName, size: input.gstr2b.size, sha256: input.gstr2b.sha256, gstin: portal.gstin, period: portal.period },
        register: { documentId: sheet.documentId, fileName: sheet.fileName, sheet: sheet.sheet, headerRow: sheet.records.headerRow },
        mapping,
      },
      entries,
      clear_previous: clearPrevious,
    };

    const { data, error } = await ctx.supabase.rpc("save_gst_recon_run", { p_payload: payload as unknown as Json });
    throwDb(error);
    const saved = (data ?? {}) as { id: string; entries: number; cleared_previous: number };
    const counts = Object.fromEntries(Object.entries(result.summary.buckets).map(([k, b]) => [k, b.count]));

    await ctx.audit({
      event: "file_upload",
      resourceType: "gst_recon_source",
      resourceId: saved.id,
      action: "gst_recon.gstr2b_upload",
      details: { client_id: client.id, period: input.period, file_name: input.gstr2b.fileName, size: input.gstr2b.size, sha256: input.gstr2b.sha256 },
    });
    await ctx.audit({
      event: "data_create",
      resourceType: "gst_recon_run",
      resourceId: saved.id,
      details: {
        client_id: client.id,
        period: input.period,
        lines: saved.entries,
        counts,
        carried: carry?.stillOpen.length ?? 0,
        cleared_previous: saved.cleared_previous ?? 0,
        register_document_id: sheet.documentId,
        replaces_run_id: sameMonth?.id ?? null,
      },
    });

    if (input.rememberMapping) {
      ctx.after(
        "Remember the column mapping",
        async () => {
          const { error: e } = await ctx.supabase.rpc("save_import_mapping", {
            p_client_id: client.id,
            p_kind: "purchase_register",
            p_mapping: { version: 1, columns: mapping, sheet: sheet.sheet, headerRow: sheet.records.headerRow } as unknown as Json,
            p_merge: false,
          });
          if (e) throw e;
        },
        "The reconciliation is saved, but the column mapping wasn't remembered. You'll map the columns again next month.",
      );
    }
    const chase = result.suppliers.filter((s) => s.chase).length;
    const title = `GST reconciliation for ${periodLabel(input.period)}: ${counts.matched ?? 0} matched, ${(counts.mismatch ?? 0) + (counts.missing_in_2b ?? 0) + (counts.missing_in_books ?? 0)} to look at${chase ? `, ${chase} ${chase === 1 ? "supplier" : "suppliers"} to chase` : ""}`;
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({ clientId: client.id, eventType: "gst_recon_run", title, metadata: { run_id: saved.id, period: input.period, counts, carried: carry?.stillOpen.length ?? 0 } }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "gst_recon_run", description: `Reconciled GSTR-2B for ${client.name}, ${periodLabel(input.period)}`, entityType: "gst_recon_run", entityId: saved.id, entityName: client.name }),
    );

    const warnings = result.warnings.filter((w) => w.code === "gstin_mismatch" || w.code === "no_client_gstin" || w.code === "no_portal_gstin").map((w) => w.message);
    return ok({ id: saved.id, entries: saved.entries, carried: carry?.stillOpen.length ?? 0, cleared: saved.cleared_previous ?? 0, warnings }, warnings);
  },
);

// =================================================================================================
// Resolutions and IMS decisions
// =================================================================================================

async function runClient(ctx: ActionContext, runId: string): Promise<{ clientId: string; period: string; clientName: string }> {
  const { data, error } = await ctx.supabase.from("gst_recon_runs_list").select("client_id, period, client_name").eq("id", runId).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That reconciliation no longer exists, or isn't one of yours.", { code: "not_found" });
  return { clientId: String(data.client_id), period: String(data.period), clientName: String(data.client_name) };
}

export type ResolvedLines = { updated: number; lines: Array<{ id: string; updatedAt: string; resolution: string }> };

/** Mark lines resolved with a note (§7.8.1), or open again; all or nothing, each line's version checked. */
export const resolveReconLines = defineAction(
  { name: "gst_recon.resolve", schema: ResolveLinesSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<ResolvedLines>> => {
    const run = await runClient(ctx, input.runId);
    const { data, error } = await ctx.supabase.rpc("set_gst_recon_resolution", {
      p_run_id: input.runId,
      p_entries: input.lines.map((l) => ({ id: l.id, updated_at: l.updatedAt })) as unknown as Json,
      p_resolution: input.resolution,
      p_note: input.note ?? "",
    });
    throwDb(error);
    const r = (data ?? {}) as { updated: number; entries: Array<{ id: string; updated_at: string; resolution: string }> };
    await ctx.audit({
      event: "data_update",
      resourceType: "gst_recon_run",
      resourceId: input.runId,
      action: "gst_recon.resolve",
      details: { client_id: run.clientId, period: run.period, resolution: input.resolution, lines: r.updated, line_ids: input.lines.slice(0, 50).map((l) => l.id), note: input.note },
    });
    ctx.after("Record the change in the reconciliation's history", () =>
      logActivity({
        entityType: "gst_recon_run",
        entityId: input.runId,
        action: "gst_recon_resolved",
        description: `${r.updated} ${r.updated === 1 ? "line" : "lines"} marked ${input.resolution === "open" ? "open again" : input.resolution === "accepted" ? "settled" : input.resolution === "ignore" ? "ignored" : "following up the supplier"}${input.note ? `: ${input.note}` : ""}`,
      }),
    );
    return ok({ updated: r.updated, lines: (r.entries ?? []).map((e) => ({ id: e.id, updatedAt: e.updated_at, resolution: e.resolution })) });
  },
);

/** The IMS decision for one 2B document (§6.12 "IMS action list … with reasons"). */
export const decideImsAction = defineAction(
  { name: "gst_recon.ims", schema: ImsDecisionSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; decidedAt: string | null }>> => {
    const run = await runClient(ctx, input.runId);
    const { data: line, error: lineError } = await ctx.supabase.from("gst_recon_entries").select("id, run_id").eq("id", input.lineId).maybeSingle();
    throwIfDbError(lineError);
    if (!line || line.run_id !== input.runId) return fail("That line is no longer in this reconciliation. Reload it.", { code: "not_found" });
    const { data, error } = await ctx.supabase.rpc("set_gst_recon_ims_action", { p_entry_id: input.lineId, p_updated_at: input.updatedAt, p_action: input.action, p_reason: input.reason });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; ims_decided_at: string | null };
    await ctx.audit({
      event: "data_update",
      resourceType: "gst_recon_entry",
      resourceId: input.lineId,
      action: "gst_recon.ims",
      details: { client_id: run.clientId, run_id: input.runId, period: run.period, ims_action: input.action, reason: input.reason },
    });
    return ok({ updatedAt: r.updated_at, decidedAt: r.ims_decided_at });
  },
);

// =================================================================================================
// Supplier follow-up (§7.8.1 "Draft supplier follow-up", §7.13.2)
// =================================================================================================

export type SupplierFollowUp = { supplierName: string | null; missingItems: string; lineCount: number };

export const supplierFollowUp = defineAction(
  { name: "gst_recon.supplier_follow_up", schema: SupplierLinesSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<SupplierFollowUp>> => {
    await runClient(ctx, input.runId);
    const f = await followUpLines(ctx.supabase, input.runId, input.supplierGstin);
    if (f.lines.length === 0) return fail("Nothing is open for this supplier: every line is settled or ignored.", { code: "blocked" });
    return ok({ supplierName: f.supplierName, missingItems: supplierMissingItems({ name: f.supplierName, gstin: input.supplierGstin.toUpperCase() }, f.lines), lineCount: f.lines.length });
  },
);

/** After a hand-off: the supplier's open lines become "Following up" (they still carry forward). */
export const markSupplierFollowedUp = defineAction(
  { name: "gst_recon.supplier_followed_up", schema: SupplierFollowedUpSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ updated: number }>> => {
    const run = await runClient(ctx, input.runId);
    const f = await followUpLines(ctx.supabase, input.runId, input.supplierGstin);
    if (f.lineIds.length === 0) return ok({ updated: 0 });
    const note = `Follow-up handed off on WhatsApp, ${formatDate(todayIST())}.`;
    const { data, error } = await ctx.supabase.rpc("set_gst_recon_resolution", {
      p_run_id: input.runId,
      p_entries: f.lineIds.map((l) => ({ id: l.id, updated_at: l.updatedAt })) as unknown as Json,
      p_resolution: "follow_up_supplier",
      p_note: note,
    });
    throwDb(error);
    const updated = Number((data as { updated?: number } | null)?.updated ?? 0);
    await ctx.audit({
      event: "data_update",
      resourceType: "gst_recon_run",
      resourceId: input.runId,
      action: "gst_recon.supplier_followed_up",
      details: { client_id: run.clientId, period: run.period, supplier_gstin: input.supplierGstin.toUpperCase(), channel: input.channel, lines: updated },
    });
    return ok({ updated });
  },
);

// =================================================================================================
// For the run page's "Run next month" and the client tab
// =================================================================================================

export type RunMapping = { columns: Record<string, string | null> | null; sheet: string | null; headerRow: number | null };

/** The client's remembered register columns (the wizard's starting mapping). */
export const getRememberedRegisterMapping = defineAction(
  { name: "gst_recon.remembered_mapping", schema: RunLookupSchema.pick({ clientId: true }), roles: STAFF },
  async (input, ctx): Promise<ActionResult<RunMapping>> => {
    await clientOrFail(ctx, input.clientId);
    return ok(savedColumns(await rememberedMapping(ctx.supabase, input.clientId, "purchase_register")));
  },
);
