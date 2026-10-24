"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult, type FieldErrors } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { isFinancialYear, type FinancialYear } from "@/lib/domain/fy";
import { ledgerKey, type BucketCode, type RememberedMappings } from "@/lib/domain/buckets";
import { classifyLedgers, mapTrialBalanceColumns, parseTrialBalanceRows, TB_FIELD_SPECS, type TbField, type TbLedger } from "@/lib/domain/schedule3";
import { validateColumnMapping, type ColumnMapping, type MappingSuggestion } from "@/lib/domain/gstr2b";
import type { Json } from "@/lib/database.types";
import type { ComboOption } from "@/components/app/form/combobox";
import { previewRows } from "@/components/workpapers/shared/sheet";
import {
  CLIENT_SEARCH,
  CreateStatementSchema,
  FS_STATUS_META,
  ReplaceTrialBalanceSchema,
  SaveStatementSchema,
  StatementLookupSchema,
  StatementStatusSchema,
  applyBucketChoices,
  emptyInputs,
  inputsFromForm,
  isFsStatus,
  readInputs,
  readLedgers,
  rebuildStatements,
  statementsAgree,
  type FsInputs,
  type FsStatus,
  type StoredLedger,
  type TbImport,
} from "@/lib/schemas/financial-statements";
import { InspectSheetSchema } from "@/lib/schemas/gst-recon";
import { SourceFileError, getReconClient, inspectVaultSheet, rememberedMapping, savedColumns, searchWorkpaperClients, type ReconClient } from "@/lib/data/gst-recon";
import { findStatement, getStatementDetail, previousStatementFor, rememberedBuckets } from "@/lib/data/financial-statements";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";
import { notify } from "@/server/notify";

/**
 * Financial statements (§6.13, §7.8.3). Any staff member who can see the client (Employees: their
 * own clients, §4.1); the guard trigger and functions of 0202 are the real control of the workflow
 * (Final only by a Manager or Partner, every check passed; Final locked; reviewer ≠ preparer).
 *
 *   inspectTrialBalance       reads the trial balance from the client's vault: sheets, header row,
 *                             preview, suggested columns (remembered per client)
 *   createFinancialStatement  reads the TB, auto-maps every ledger to a Schedule III bucket
 *                             (remembered choices first), builds the statements with last year's
 *                             comparatives, and saves the draft
 *   replaceTrialBalance       a revised TB for the same statement, keeping the inputs and choices
 *   saveFinancialStatement    the editor's save and autosave: bucket choices and inputs; the
 *                             statements are always rebuilt here from the stored ledgers, never
 *                             taken from the browser (§6.13)
 *   setFinancialStatementStatus  Draft → Reviewed → Final, or back to Draft with a note
 *
 * Every mutation writes an audit row; the timeline, history, remembered mappings and notices follow
 * in ctx.after (§0.1 rule 5). Nothing here is fee data.
 */

const STAFF = STAFF_ROLES;

function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

async function clientOrFail(ctx: ActionContext, clientId: string): Promise<ReconClient> {
  const client = await getReconClient(ctx.supabase, clientId);
  if (!client) throw new ActionError("That client isn't one of yours, or it is in the recycle bin.", { code: "not_found" });
  return client;
}

function prefixed(errors: FieldErrors, prefix: string): FieldErrors {
  return Object.fromEntries(Object.entries(errors).map(([k, v]) => [`${prefix}.${k}`, v]));
}

// =================================================================================================
// Lookups
// =================================================================================================

export const searchStatementClients = defineAction(
  { name: "financial_statements.search_clients", schema: CLIENT_SEARCH, roles: STAFF },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchWorkpaperClients(ctx.supabase, input.q)),
);

export type StatementContext = {
  client: { id: string; name: string; code: string; entityType: string | null };
  existing: { id: string; status: FsStatus } | null;
  previous: { id: string; financialYear: FinancialYear; status: FsStatus; hasFigures: boolean } | null;
};

export const getStatementContext = defineAction(
  { name: "financial_statements.context", schema: StatementLookupSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<StatementContext>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const [existing, previous] = await Promise.all([findStatement(ctx.supabase, client.id, input.financialYear), previousStatementFor(ctx.supabase, client.id, input.financialYear)]);
    return ok({
      client: { id: client.id, name: client.name, code: client.code, entityType: client.entityType },
      existing,
      previous: previous ? { id: previous.id, financialYear: previous.financialYear, status: previous.status, hasFigures: previous.figures !== null } : null,
    });
  },
);

export type InspectedTrialBalance = {
  documentId: string;
  fileName: string;
  sheets: string[];
  sheet: string | null;
  headerRow: number;
  headers: string[];
  preview: string[][];
  rowCount: number;
  truncated: boolean;
  suggestion: MappingSuggestion<TbField>;
  remembered: boolean;
  positiveBalanceIs: "debit" | "credit";
};

/** The trial balance's columns and the suggested mapping (§7.8.3 step 3, remembered per client). */
export const inspectTrialBalance = defineAction(
  { name: "financial_statements.inspect_tb", schema: InspectSheetSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<InspectedTrialBalance>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const remembered = await rememberedMapping(ctx.supabase, client.id, "trial_balance");
    const saved = savedColumns(remembered);
    let sheet;
    try {
      sheet = await inspectVaultSheet(ctx.supabase, { clientId: client.id, documentId: input.documentId, sheet: input.sheet ?? saved.sheet, headerRow: input.headerRow ?? null }, TB_FIELD_SPECS);
    } catch (err) {
      if (err instanceof SourceFileError) return fail(err.message, { fieldErrors: { file: [err.message] } });
      throw err;
    }
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
      suggestion: mapTrialBalanceColumns(sheet.records.headers, saved.columns as Partial<Record<TbField, string | null>> | null),
      remembered: Boolean(saved.columns),
      positiveBalanceIs: remembered?.positiveBalanceIs === "credit" ? "credit" : "debit",
    });
  },
);

// =================================================================================================
// Trial balance → ledgers
// =================================================================================================

type ReadTb = { ledgers: TbLedger[]; tb: TbImport; warnings: string[]; rejected: number };

async function readTrialBalance(
  ctx: ActionContext,
  clientId: string,
  input: { file: { documentId: string; sheet: string | null; headerRow: number | null }; mapping: Record<TbField, string | null>; positiveBalanceIs: "debit" | "credit" },
): Promise<ReadTb> {
  let sheet;
  try {
    sheet = await inspectVaultSheet(ctx.supabase, { clientId, documentId: input.file.documentId, sheet: input.file.sheet, headerRow: input.file.headerRow }, TB_FIELD_SPECS);
  } catch (err) {
    if (err instanceof SourceFileError) throw new ActionError(err.message, { code: "validation", fieldErrors: { file: [err.message] } });
    throw err;
  }
  const mapping = input.mapping as ColumnMapping<TbField>;
  const mappingErrors = validateColumnMapping(mapping, sheet.records.headers, TB_FIELD_SPECS);
  if (mappingErrors) throw new ActionError("Check the column mapping.", { code: "validation", fieldErrors: prefixed(mappingErrors, "mapping") });
  if (!mapping.ledgerName) throw new ActionError("Choose the column that holds the ledger names.", { code: "validation", fieldErrors: { "mapping.ledgerName": ["Choose the column that holds the ledger names."] } });
  if (!(mapping.debit && mapping.credit) && !mapping.balance) {
    const msg = "Choose the debit and credit columns, or one closing-balance column.";
    throw new ActionError(msg, { code: "validation", fieldErrors: { "mapping.debit": [msg] } });
  }
  const parsed = parseTrialBalanceRows(sheet.records.rows, mapping, { firstRowNumber: sheet.records.firstRowNumber, positiveBalanceIs: input.positiveBalanceIs });
  if (parsed.ledgers.length === 0) {
    const first = parsed.issues.find((i) => i.level === "error");
    const msg = `No ledgers could be read from the trial balance${first ? `: row ${first.row}, ${first.message}` : "."} Check the column mapping.`;
    throw new ActionError(msg, { code: "validation", fieldErrors: { file: [msg] } });
  }
  const errors = parsed.issues.filter((i) => i.level === "error");
  const warnings: string[] = [];
  if (errors.length > 0) {
    warnings.push(`${errors.length} ${errors.length === 1 ? "row was" : "rows were"} left out of the trial balance (for example row ${errors[0].row}: ${errors[0].message}).`);
  }
  if (sheet.records.truncated) warnings.push("The file has more rows than the app reads; only the first 1,00,000 were used.");
  return {
    ledgers: parsed.ledgers,
    tb: { documentId: sheet.documentId, fileName: sheet.fileName, sheet: sheet.sheet, headerRow: sheet.records.headerRow, mapping: { ...mapping }, positiveBalanceIs: input.positiveBalanceIs },
    warnings,
    rejected: errors.length,
  };
}

function storedFrom(ledgers: TbLedger[], remembered: RememberedMappings): StoredLedger[] {
  return classifyLedgers(ledgers, remembered).map((l) => ({
    name: l.name,
    group: l.group,
    debit: l.debit,
    credit: l.credit,
    row: l.row,
    bucket: l.bucket,
    matched: l.bucket !== null,
    source: l.classification.source,
    confidence: l.classification.confidence,
    reason: l.classification.reason,
  }));
}

function summaryOf(ledgers: readonly StoredLedger[], statements: { allChecksPassed: boolean; checks: Array<{ status: string }> }) {
  return {
    ledgers: ledgers.length,
    unmapped: ledgers.filter((l) => l.bucket === null).length,
    all_checks_passed: statements.allChecksPassed,
    failed_checks: statements.checks.filter((c) => c.status === "fail").length,
  };
}

function rememberTbMapping(ctx: ActionContext, clientId: string, tb: TbImport) {
  ctx.after(
    "Remember the trial balance columns",
    async () => {
      const { error } = await ctx.supabase.rpc("save_import_mapping", {
        p_client_id: clientId,
        p_kind: "trial_balance",
        p_mapping: { version: 1, columns: tb.mapping, sheet: tb.sheet, headerRow: tb.headerRow, positiveBalanceIs: tb.positiveBalanceIs } as unknown as Json,
        p_merge: false,
      });
      if (error) throw error;
    },
    "The statement is saved, but the trial balance columns weren't remembered. You'll map them again next time.",
  );
}

function rememberBucketChoices(ctx: ActionContext, clientId: string, choices: Record<string, BucketCode | null>) {
  if (Object.keys(choices).length === 0) return;
  ctx.after(
    "Remember the ledger mapping",
    async () => {
      const { error } = await ctx.supabase.rpc("save_import_mapping", { p_client_id: clientId, p_kind: "ledger_buckets", p_mapping: choices as unknown as Json, p_merge: true });
      if (error) throw error;
    },
    "The statement is saved, but the ledger mapping wasn't remembered for next year.",
  );
}

// =================================================================================================
// Create (§7.8.3 steps 1–5)
// =================================================================================================

export const createFinancialStatement = defineAction(
  { name: "financial_statements.create", schema: CreateStatementSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ id: string; unmapped: number }>> => {
    const client = await clientOrFail(ctx, input.clientId);
    const fy = input.financialYear;
    const existing = await findStatement(ctx.supabase, client.id, fy);
    if (existing) {
      return fail(`This client already has a statement for FY ${fy}. Open it to upload a new trial balance.`, { code: "conflict", fieldErrors: { financialYear: [`There is already a statement for FY ${fy}.`] } });
    }
    const tb = await readTrialBalance(ctx, client.id, input);
    const [remembered, previous] = await Promise.all([rememberedBuckets(ctx.supabase, client.id), previousStatementFor(ctx.supabase, client.id, fy)]);
    const ledgers = storedFrom(tb.ledgers, remembered);
    const inputs: FsInputs = { ...emptyInputs(client.entityType), tb: tb.tb };
    const statements = rebuildStatements(ledgers, inputs, { financialYear: fy, previous: previous?.figures ?? null });

    const { data, error } = await ctx.supabase.rpc("save_financial_statement", {
      p_payload: {
        client_id: client.id,
        financial_year: fy,
        ledgers,
        statements,
        inputs,
        source_document_id: tb.tb.documentId,
        previous_statement_id: previous?.figures ? previous.id : null,
      } as unknown as Json,
    });
    throwDb(error);
    const saved = (data ?? {}) as { id: string };
    const s = summaryOf(ledgers, statements);
    await ctx.audit({ event: "data_create", resourceType: "financial_statement", resourceId: saved.id, details: { client_id: client.id, financial_year: fy, source_document_id: tb.tb.documentId, ...s } });

    if (input.rememberMapping) rememberTbMapping(ctx, client.id, tb.tb);
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({
        clientId: client.id,
        eventType: "financial_statements_started",
        title: `Financial statements for FY ${fy} started from the trial balance (${s.ledgers} ledgers)`,
        metadata: { statement_id: saved.id, financial_year: fy, ledgers: s.ledgers, unmapped: s.unmapped },
      }),
    );
    ctx.after("Add to your activity", () =>
      logEmployeeActivity({ activityType: "financial_statements_started", description: `Started the FY ${fy} financial statements for ${client.name}`, entityType: "financial_statement", entityId: saved.id, entityName: client.name }),
    );
    return ok({ id: saved.id, unmapped: s.unmapped }, tb.warnings);
  },
);

// =================================================================================================
// Load a statement for an update
// =================================================================================================

type Current = { id: string; clientId: string; fy: FinancialYear; status: FsStatus; ledgers: StoredLedger[]; inputs: FsInputs; client: ReconClient; previousId: string | null };

async function currentStatement(ctx: ActionContext, id: string): Promise<Current> {
  const { data, error } = await ctx.supabase.from("financial_statements").select("id, client_id, financial_year, status, ledgers, inputs, previous_statement_id").eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That statement no longer exists, or isn't one of yours.", { code: "not_found" });
  const client = await clientOrFail(ctx, data.client_id);
  if (!isFinancialYear(data.financial_year)) throw new ActionError("This statement's year isn't valid.");
  return {
    id: data.id,
    clientId: data.client_id,
    fy: data.financial_year,
    status: isFsStatus(data.status) ? data.status : "draft",
    ledgers: readLedgers(data.ledgers),
    inputs: readInputs(data.inputs, client.entityType),
    client,
    previousId: data.previous_statement_id,
  };
}

// =================================================================================================
// Save and autosave (§3.4 "autosave a draft every 5 seconds … as a server DRAFT")
// =================================================================================================

export type SavedStatement = { id: string; updatedAt: string; status: FsStatus; sentBackToDraft: boolean };

export const saveFinancialStatement = defineAction(
  { name: "financial_statements.save", schema: SaveStatementSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<SavedStatement>> => {
    const cur = await currentStatement(ctx, input.id);
    if (cur.status === "final") return fail("This statement is final. A Manager or Partner can reopen it to make changes.", { code: "blocked" });
    if (input.autosave && cur.status !== "draft") return fail("Autosave only saves drafts. Save to send the statement back to Draft.", { code: "blocked" });

    const invalid = input.buckets.find((c) => c.index >= cur.ledgers.length);
    if (invalid) return fail("The trial balance changed since you opened it. Reload to see the current ledgers.", { code: "conflict" });
    const ledgers = applyBucketChoices(cur.ledgers, input.buckets);
    const inputs = inputsFromForm(input.inputs, cur.inputs.tb);
    const previous = await previousStatementFor(ctx.supabase, cur.clientId, cur.fy);
    const statements = rebuildStatements(ledgers, inputs, { financialYear: cur.fy, previous: previous?.figures ?? null });

    const { data, error } = await ctx.supabase.rpc("save_financial_statement", {
      p_payload: {
        id: cur.id,
        updated_at: input.updatedAt,
        ledgers,
        statements,
        inputs,
        previous_statement_id: previous?.figures ? previous.id : null,
      } as unknown as Json,
    });
    throwDb(error);
    const r = (data ?? {}) as { id: string; status: string; updated_at: string };
    const status: FsStatus = isFsStatus(r.status) ? r.status : "draft";
    const sentBack = cur.status === "reviewed" && status === "draft";

    const changed: Record<string, BucketCode | null> = {};
    input.buckets.forEach((c) => {
      const before = cur.ledgers[c.index];
      if (before && before.bucket !== c.bucket) changed[ledgerKey(before.name)] = c.bucket;
    });
    const s = summaryOf(ledgers, statements);
    await ctx.audit({
      event: "data_update",
      resourceType: "financial_statement",
      resourceId: cur.id,
      action: input.autosave ? "financial_statements.autosave" : "financial_statements.save",
      details: { client_id: cur.clientId, financial_year: cur.fy, buckets_changed: Object.keys(changed).length, sent_back_to_draft: sentBack, ...s },
    });
    if (input.rememberBuckets) rememberBucketChoices(ctx, cur.clientId, changed);
    if (!input.autosave) {
      ctx.after("Record the change in the statement's history", () =>
        logActivity({
          entityType: "financial_statement",
          entityId: cur.id,
          action: "financial_statement_saved",
          description: `Saved: ${s.unmapped === 0 ? "every ledger mapped" : `${s.unmapped} ${s.unmapped === 1 ? "ledger" : "ledgers"} unmapped`}, ${s.all_checks_passed ? "every check passes" : `${s.failed_checks} ${s.failed_checks === 1 ? "check fails" : "checks fail"}`}${sentBack ? ". Back to Draft for a fresh review." : "."}`,
        }),
      );
    }
    const warnings = sentBack ? ["The figures changed after the review, so the statement is back in Draft. Ask for a fresh review."] : undefined;
    return ok({ id: cur.id, updatedAt: r.updated_at, status, sentBackToDraft: sentBack }, warnings);
  },
);

// =================================================================================================
// A revised trial balance for the same statement
// =================================================================================================

export const replaceTrialBalance = defineAction(
  { name: "financial_statements.replace_tb", schema: ReplaceTrialBalanceSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<SavedStatement & { unmapped: number }>> => {
    const cur = await currentStatement(ctx, input.id);
    if (cur.status === "final") return fail("This statement is final. A Manager or Partner can reopen it before a new trial balance is loaded.", { code: "blocked" });
    const tb = await readTrialBalance(ctx, cur.clientId, input);
    // The choices made on this statement come first, then the client's remembered ones.
    const own: Record<string, BucketCode> = {};
    for (const l of cur.ledgers) if (l.bucket && (l.source === "manual" || l.source === "remembered")) own[ledgerKey(l.name)] = l.bucket;
    const remembered = { ...(await rememberedBuckets(ctx.supabase, cur.clientId)), ...own };
    const ledgers = storedFrom(tb.ledgers, remembered);
    const inputs: FsInputs = { ...cur.inputs, tb: tb.tb };
    const previous = await previousStatementFor(ctx.supabase, cur.clientId, cur.fy);
    const statements = rebuildStatements(ledgers, inputs, { financialYear: cur.fy, previous: previous?.figures ?? null });

    const { data, error } = await ctx.supabase.rpc("save_financial_statement", {
      p_payload: {
        id: cur.id,
        updated_at: input.updatedAt,
        ledgers,
        statements,
        inputs,
        source_document_id: tb.tb.documentId,
        previous_statement_id: previous?.figures ? previous.id : null,
      } as unknown as Json,
    });
    throwDb(error);
    const r = (data ?? {}) as { id: string; status: string; updated_at: string };
    const status: FsStatus = isFsStatus(r.status) ? r.status : "draft";
    const s = summaryOf(ledgers, statements);
    await ctx.audit({
      event: "data_update",
      resourceType: "financial_statement",
      resourceId: cur.id,
      action: "financial_statements.replace_tb",
      details: { client_id: cur.clientId, financial_year: cur.fy, source_document_id: tb.tb.documentId, ...s },
    });
    if (input.rememberMapping) rememberTbMapping(ctx, cur.clientId, tb.tb);
    ctx.after("Record the change in the statement's history", () =>
      logActivity({ entityType: "financial_statement", entityId: cur.id, action: "financial_statement_tb_replaced", description: `New trial balance loaded: ${tb.tb.fileName ?? "file"} (${s.ledgers} ledgers).` }),
    );
    const sentBack = cur.status === "reviewed" && status === "draft";
    const warnings = [...tb.warnings, ...(sentBack ? ["The trial balance changed after the review, so the statement is back in Draft."] : [])];
    return ok({ id: cur.id, updatedAt: r.updated_at, status, sentBackToDraft: sentBack, unmapped: s.unmapped }, warnings);
  },
);

// =================================================================================================
// Draft → Reviewed → Final (§7.8.3)
// =================================================================================================

export const setFinancialStatementStatus = defineAction(
  { name: "financial_statements.status", schema: StatementStatusSchema, roles: STAFF },
  async (input, ctx): Promise<ActionResult<{ status: FsStatus; updatedAt: string }>> => {
    if (input.status === "final" && ctx.user.role === "employee") {
      return fail("Only a Manager or Partner can mark a statement final.", { code: "forbidden" });
    }
    const { data: before, error: beforeError } = await ctx.supabase.from("financial_statements").select("id, client_id, financial_year, status, prepared_by").eq("id", input.id).maybeSingle();
    throwIfDbError(beforeError);
    if (!before) return fail("That statement no longer exists, or isn't one of yours.", { code: "not_found" });
    if (input.status === "reviewed" || input.status === "final") {
      // What is reviewed or finalised is what the server builds from the stored trial balance and
      // inputs (§6.13), never figures saved some other way or left stale by last year's changes.
      const detail = await getStatementDetail(ctx.supabase, input.id);
      if (!detail) return fail("That statement no longer exists, or isn't one of yours.", { code: "not_found" });
      const rebuilt = rebuildStatements(detail.ledgers, detail.inputs, { financialYear: detail.row.financial_year, previous: detail.previousFigures });
      if (!statementsAgree(detail.statements, rebuilt)) {
        return fail("The saved figures don't match what its trial balance and inputs give now (last year's statement may have changed). Open the statement and save it to rebuild them, then review it.", { code: "blocked" });
      }
    }
    const { data, error } = await ctx.supabase.rpc("set_financial_statement_status", { p_id: input.id, p_updated_at: input.updatedAt, p_status: input.status, p_note: input.note ?? "" });
    throwDb(error);
    const r = (data ?? {}) as { status: string; updated_at: string };
    const status: FsStatus = isFsStatus(r.status) ? r.status : input.status;
    const from = isFsStatus(before.status) ? before.status : "draft";
    await ctx.audit({
      event: "data_update",
      resourceType: "financial_statement",
      resourceId: input.id,
      action: `financial_statements.${status}`,
      details: { client_id: before.client_id, financial_year: before.financial_year, from, to: status, note: input.note },
    });
    const fy = before.financial_year;
    const verb = status === "final" ? "marked Final" : status === "reviewed" ? "reviewed" : from === "final" ? "reopened as a Draft" : "sent back to Draft";
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({
        clientId: before.client_id,
        eventType: `financial_statements_${status}`,
        title: `Financial statements for FY ${fy} ${verb} by ${ctx.user.fullName}`,
        description: status === "draft" ? input.note : null,
        metadata: { statement_id: input.id, financial_year: fy, from, to: status },
      }),
    );
    ctx.after("Record the change in the statement's history", () =>
      logActivity({ entityType: "financial_statement", entityId: input.id, action: `financial_statement_${status}`, description: `${FS_STATUS_META[status].label}${input.note ? `: ${input.note}` : ""}` }),
    );
    if (status === "draft" && before.prepared_by && before.prepared_by !== ctx.user.id) {
      ctx.after(
        "Tell the preparer",
        () =>
          notify({
            to: { userIds: [before.prepared_by as string] },
            type: "info",
            title: `FY ${fy} financial statements ${from === "final" ? "reopened" : "sent back"}`,
            body: `${ctx.user.fullName}: ${input.note ?? ""}`.slice(0, 500),
            linkUrl: `/workpapers/financial-statements/${input.id}`,
            entity: { type: "financial_statement", id: input.id },
            clientId: before.client_id,
            dedupeKey: `fs_sent_back:${input.id}:${r.updated_at}`,
          }),
        "The statement moved back to Draft, but the preparer wasn't told. Let them know.",
      );
    }
    return ok({ status, updatedAt: r.updated_at });
  },
);
