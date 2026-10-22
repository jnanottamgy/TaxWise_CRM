"use server";

import { untyped } from "@/lib/supabase/untyped";
import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatDate, formatTime } from "@/lib/format";
import { financialYearOf, todayIST } from "@/lib/domain/fy";
import {
  approvalLimitsFromForm,
  BankSchema,
  BillingSchema,
  checkLogoBytes,
  FirmDetailsSchema,
  HolidayRemoveSchema,
  HolidaySchema,
  LOGO_EXTENSION,
  LOGO_MAX_BYTES,
  LogoConfirmSchema,
  LogoRemoveSchema,
  LogoUploadRequestSchema,
  NumberingSchema,
  RemindersSchema,
  sacMapToJson,
  WorkingHoursSchema,
} from "@/lib/schemas/settings";
import { formatSeriesNumber, SERIES, type SeriesKey } from "@/lib/domain/numbering";
import { getPartners, getProfileNames, logoPublicUrl, type FirmSettingsRow } from "@/lib/data/settings";
import { diagnosticsAccess, isDiagnosticCheckId, runCheck, type DiagnosticResult } from "@/server/diagnostics";
import { logUnexpected } from "@/lib/log";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Settings → firm-level sections (§7.21). Partner only (server: `roles: ["partner"]`; RLS lets only
 * Partners update firm_settings, §4.6). Every save:
 * - carries the firm_settings row's `updated_at` as loaded and updates with `.eq("updated_at", …)`,
 *   so a concurrent change is refused with who changed it and when (§13);
 * - writes a `config_change` audit row with a before/after summary of what changed (§0.1 rule 12);
 * - returns the new `updated_at`, so the form can keep saving without a reload.
 */

type Patch = Record<string, unknown>;
type Change = { field: string; before: unknown; after: unknown };

const SETTINGS_RESOURCE = "firm_settings";
/** Values never written to the audit log in full. */
const MASKED_FIELDS = new Set(["bank_account_number"]);
const LONG_TEXT = 160;

function mask(field: string, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  if (MASKED_FIELDS.has(field)) {
    const s = String(v);
    return s.length > 4 ? `••••${s.slice(-4)}` : "••••";
  }
  if (typeof v === "string" && v.length > LONG_TEXT) return `${v.slice(0, LONG_TEXT - 1)}… (${v.length} characters)`;
  return v;
}

/** Comparable form of a column value: numeric strings as numbers, `09:30:00` as `09:30`, "" as null. */
function norm(field: string, v: unknown): string {
  if (v === undefined || v === "" || v === null) return "null";
  if (field === "work_day_start" && typeof v === "string") return JSON.stringify(v.slice(0, 5));
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return JSON.stringify(Number(v));
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => (typeof x === "string" && /^-?\d+$/.test(x) ? Number(x) : x)));
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, typeof o[k] === "string" && /^-?\d+(\.\d+)?$/.test(String(o[k])) ? Number(o[k]) : o[k]])));
  }
  return JSON.stringify(v);
}

function diff(before: Patch, after: Patch): Change[] {
  const out: Change[] = [];
  for (const [field, value] of Object.entries(after)) {
    if (norm(field, before[field]) !== norm(field, value)) out.push({ field, before: mask(field, before[field]), after: mask(field, value) });
  }
  return out;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

async function whoChanged(supabase: ServerSupabase, row: { updated_at: string | null; updated_by?: string | null }): Promise<string> {
  let name: string | null = null;
  try {
    if (row.updated_by) name = (await getProfileNames(supabase, [row.updated_by])).get(row.updated_by) ?? null;
  } catch {
    name = null;
  }
  const at = row.updated_at;
  const when = at ? (formatDate(at) === formatDate(new Date()) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`) : "a moment ago";
  return `Changed by ${name ?? "someone else"} at ${when}. Reload to see their changes.`;
}

async function loadSettings<K extends keyof FirmSettingsRow>(
  supabase: ServerSupabase,
  columns: readonly K[],
): Promise<Pick<FirmSettingsRow, K | "updated_at" | "updated_by">> {
  const cols = [...new Set<string>([...columns, "updated_at", "updated_by"])].join(", ");
  const { data, error } = await supabase.from("firm_settings").select(cols).eq("id", 1).maybeSingle();
  throwIfDbError(error);
  if (!data) {
    throw new ActionError("The firm's settings row is missing. Ask whoever set up the database to run the database seed.", { code: "not_found" });
  }
  return data as unknown as Pick<FirmSettingsRow, K | "updated_at" | "updated_by">;
}

/** Updates firm_settings under the concurrency check; returns the new updated_at. */
async function updateSettings(ctx: ActionContext, loaded: string, patch: Patch): Promise<string> {
  const { data, error } = await ctx.supabase
    .from("firm_settings")
    .update({ ...patch, updated_by: ctx.user.id })
    .eq("id", 1)
    .eq("updated_at", loaded)
    .select("updated_at")
    .maybeSingle();
  throwIfDbError(error);
  if (!data) {
    const fresh = await loadSettings(ctx.supabase, []);
    throw new ActionError(await whoChanged(ctx.supabase, fresh), { code: "conflict" });
  }
  return (data as { updated_at: string }).updated_at;
}

/**
 * The common path for a panel that edits firm_settings columns: load what is there, refuse a stale
 * form, write only when something changed, audit what changed.
 */
async function saveSettingsPanel(
  ctx: ActionContext,
  section: string,
  loaded: string,
  patch: Patch,
): Promise<{ updated_at: string; changes: Change[] }> {
  const before = await loadSettings(ctx.supabase, Object.keys(patch) as Array<keyof FirmSettingsRow>);
  if (!sameInstant(before.updated_at, loaded)) {
    throw new ActionError(await whoChanged(ctx.supabase, before), { code: "conflict" });
  }
  const changes = diff(before as unknown as Patch, patch);
  if (changes.length === 0) return { updated_at: before.updated_at, changes };
  const changedPatch = Object.fromEntries(changes.map((c) => [c.field, patch[c.field]]));
  const updated_at = await updateSettings(ctx, loaded, changedPatch);
  await ctx.audit({
    event: "config_change",
    resourceType: SETTINGS_RESOURCE,
    resourceId: "1",
    action: `settings.${section}.update`,
    details: { section, changes },
  });
  return { updated_at, changes };
}

export interface SaveResult {
  updated_at: string;
  changed: number;
}

// -------------------------------------------------------------------------------------------------
// Firm details (§1, §7.21)
// -------------------------------------------------------------------------------------------------

export const saveFirmDetails = defineAction(
  { name: "settings.firm.save", schema: FirmDetailsSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<SaveResult>> => {
    const patch: Patch = {
      firm_name: input.firm_name,
      legal_name: input.legal_name,
      tagline: input.tagline,
      address: input.address,
      city: input.city,
      state_code: input.state_code,
      pincode: input.pincode,
      phone: input.phone,
      email: input.email,
      website: input.website,
      gstin: input.gstin,
      pan: input.pan,
      tan: input.tan,
      icai_frn: input.icai_frn,
    };
    const { updated_at, changes } = await saveSettingsPanel(ctx, "firm", input.updated_at, patch);

    // Partners' ICAI membership numbers live on their profiles (§5.2).
    const warnings: string[] = [];
    let partnerChanges = 0;
    if (input.partners.length > 0) {
      const current = new Map((await getPartners(ctx.supabase)).map((p) => [p.id, p]));
      const memberChanges: Change[] = [];
      for (const p of input.partners) {
        const was = current.get(p.id);
        if (!was) continue; // no longer an active Partner: nothing to change
        if ((was.icai_membership_no ?? null) === (p.icai_membership_no ?? null)) continue;
        const { data, error } = await ctx.supabase
          .from("profiles")
          .update({ icai_membership_no: p.icai_membership_no })
          .eq("id", p.id)
          .eq("role", "partner")
          .select("id");
        if (error || !data || (data as unknown[]).length === 0) {
          warnings.push(`${was.full_name}'s membership number wasn't saved. Ask them to add it under Profile, or try again.`);
          continue;
        }
        memberChanges.push({ field: `icai_membership_no:${was.full_name}`, before: was.icai_membership_no, after: p.icai_membership_no });
      }
      if (memberChanges.length) {
        partnerChanges = memberChanges.length;
        await ctx.audit({
          event: "config_change",
          resourceType: "profiles",
          action: "settings.firm.membership_numbers",
          details: { section: "firm", changes: memberChanges },
        });
      }
    }
    return ok({ updated_at, changed: changes.length + partnerChanges }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// Logo (§1: PNG/SVG/JPG ≤ 1 MB). Two steps; see LogoUploadRequestSchema.
// -------------------------------------------------------------------------------------------------

export const requestLogoUpload = defineAction(
  { name: "settings.logo.request", schema: LogoUploadRequestSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ path: string; token: string }>> => {
    const path = `logo/${crypto.randomUUID()}.${LOGO_EXTENSION[input.kind]}`;
    const { data, error } = await ctx.supabase.storage.from("branding").createSignedUploadUrl(path);
    if (error || !data) {
      throw Object.assign(new Error(`branding upload URL: ${error?.message ?? "no data"}`), { code: "storage" });
    }
    return ok({ path, token: data.token });
  },
);

async function fetchStoredLogo(supabase: ServerSupabase, path: string): Promise<Uint8Array> {
  const url = logoPublicUrl(supabase, { logo_path: path, logo_updated_at: null });
  if (!url) throw new ActionError("The upload didn't arrive. Try again.");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (res.status === 404 || res.status === 400) throw new ActionError("The upload didn't arrive. Try again.");
  if (!res.ok) throw new Error(`branding fetch ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > LOGO_MAX_BYTES) throw new ActionError("The logo is larger than 1 MB. Use a smaller file.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes;
}

export const confirmLogo = defineAction(
  { name: "settings.logo.confirm", schema: LogoConfirmSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updated_at: string; logoUrl: string | null }>> => {
    const before = await loadSettings(ctx.supabase, ["logo_path", "logo_updated_at"]);
    if (!sameInstant(before.updated_at, input.updated_at)) {
      throw new ActionError(await whoChanged(ctx.supabase, before), { code: "conflict" });
    }

    const discard = async () => {
      try {
        await ctx.supabase.storage.from("branding").remove([input.path]);
      } catch {
        // Left behind: an unreferenced file in the branding bucket, harmless.
      }
    };

    const bytes = await fetchStoredLogo(ctx.supabase, input.path);
    const check = checkLogoBytes(bytes, bytes.length);
    if (!check.ok) {
      await discard();
      throw new ActionError(check.error, { fieldErrors: { file: [check.error] } });
    }
    if (!input.path.endsWith(`.${LOGO_EXTENSION[check.kind]}`)) {
      await discard();
      throw new ActionError("The file's contents don't match its type. Upload it again.");
    }

    const now = new Date().toISOString();
    const updated_at = await updateSettings(ctx, input.updated_at, { logo_path: input.path, logo_updated_at: now });
    await ctx.audit({
      event: "config_change",
      resourceType: SETTINGS_RESOURCE,
      resourceId: "1",
      action: "settings.logo.update",
      details: { section: "firm", changes: [{ field: "logo_path", before: before.logo_path, after: input.path }], bytes: bytes.length, kind: check.kind },
    });
    const old = before.logo_path?.replace(/^branding\//, "");
    if (old && old !== input.path) {
      ctx.after("Remove the old logo file", async () => {
        const { error } = await ctx.supabase.storage.from("branding").remove([old]);
        if (error) throw new Error(error.message);
      }, "The new logo is saved; the old file couldn't be removed from storage. It does no harm.");
    }
    return ok({ updated_at, logoUrl: logoPublicUrl(ctx.supabase, { logo_path: input.path, logo_updated_at: now }) });
  },
);

export const removeLogo = defineAction(
  { name: "settings.logo.remove", schema: LogoRemoveSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updated_at: string }>> => {
    const before = await loadSettings(ctx.supabase, ["logo_path"]);
    if (!sameInstant(before.updated_at, input.updated_at)) {
      throw new ActionError(await whoChanged(ctx.supabase, before), { code: "conflict" });
    }
    if (!before.logo_path) return ok({ updated_at: before.updated_at });
    const updated_at = await updateSettings(ctx, input.updated_at, { logo_path: null, logo_updated_at: new Date().toISOString() });
    await ctx.audit({
      event: "config_change",
      resourceType: SETTINGS_RESOURCE,
      resourceId: "1",
      action: "settings.logo.remove",
      details: { section: "firm", changes: [{ field: "logo_path", before: before.logo_path, after: null }] },
    });
    const old = before.logo_path.replace(/^branding\//, "");
    ctx.after("Remove the logo file", async () => {
      const { error } = await ctx.supabase.storage.from("branding").remove([old]);
      if (error) throw new Error(error.message);
    }, "The logo is removed from documents; the file couldn't be deleted from storage. It does no harm.");
    return ok({ updated_at });
  },
);

// -------------------------------------------------------------------------------------------------
// Bank & UPI
// -------------------------------------------------------------------------------------------------

export const saveBank = defineAction(
  { name: "settings.bank.save", schema: BankSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<SaveResult>> => {
    const { updated_at, changes } = await saveSettingsPanel(ctx, "bank", input.updated_at, {
      bank_name: input.bank_name,
      bank_account_name: input.bank_account_name,
      bank_account_number: input.bank_account_number,
      bank_ifsc: input.bank_ifsc,
      bank_branch: input.bank_branch,
      upi_id: input.upi_id,
      upi_payee_name: input.upi_payee_name,
    });
    return ok({ updated_at, changed: changes.length });
  },
);

// -------------------------------------------------------------------------------------------------
// Numbering (§0.1 rule 6, §5.11): prefixes and the next number per series
// -------------------------------------------------------------------------------------------------

/** Where each series' numbers are stored (the column is unique in every case). */
const SERIES_TARGET: Record<SeriesKey, { table: string; column: string }> = {
  invoice: { table: "invoices", column: "invoice_number" },
  credit_note: { table: "credit_notes", column: "credit_note_number" },
  quotation: { table: "quotations", column: "quotation_number" },
  receipt: { table: "payment_receipts", column: "receipt_number" },
  client_code: { table: "clients", column: "client_code" },
  task: { table: "tasks", column: "task_number" },
  lead: { table: "leads", column: "lead_number" },
};

/** Lowering a counter is checked number by number against what was issued; this caps the work. */
const MAX_LOWERING = 1000;

async function takenNumbers(supabase: ServerSupabase, key: SeriesKey, prefix: string, fy: string, fromSeq: number, toSeqExclusive: number): Promise<string[]> {
  const target = SERIES_TARGET[key];
  const candidates: string[] = [];
  for (let seq = fromSeq; seq < toSeqExclusive; seq++) candidates.push(formatSeriesNumber(key, { seq, prefix, fy }));
  const taken: string[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const { data, error } = await untyped(supabase).from(target.table).select(target.column).in(target.column, chunk).limit(chunk.length);
    throwIfDbError(error);
    for (const r of (data ?? []) as unknown as Array<Record<string, string>>) taken.push(r[target.column]);
  }
  return taken.sort();
}

export const saveNumbering = defineAction(
  { name: "settings.numbering.save", schema: NumberingSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<SaveResult & { series: Array<{ key: SeriesKey; updated_at: string; next_value: number }> }>> => {
    const fy = financialYearOf(todayIST());
    const prefixPatch: Patch = {
      invoice_prefix: input.invoice_prefix,
      credit_note_prefix: input.credit_note_prefix,
      quotation_prefix: input.quotation_prefix,
      receipt_prefix: input.receipt_prefix,
      client_code_prefix: input.client_code_prefix,
    };
    const before = await loadSettings(ctx.supabase, Object.keys(prefixPatch) as Array<keyof FirmSettingsRow>);
    if (!sameInstant(before.updated_at, input.updated_at)) {
      throw new ActionError(await whoChanged(ctx.supabase, before), { code: "conflict" });
    }
    const prefixOf = (key: SeriesKey): string => {
      const setting = SERIES[key].prefixSetting;
      return setting ? String(prefixPatch[setting]) : SERIES[key].defaultPrefix;
    };

    // Check every changed counter before writing anything.
    const warnings: string[] = [];
    const counterChanges = input.series.filter((s) => s.loaded_next_value === undefined || s.loaded_next_value === null || s.next_value !== s.loaded_next_value);
    const plans: Array<{ key: SeriesKey; next: number; current: { exists: boolean; updated_at: string | null; next_value: number; financial_year: string | null } }> = [];
    if (counterChanges.length) {
      const { data, error } = await ctx.supabase.from("number_series").select("key, financial_year, next_value, updated_at").in("key", counterChanges.map((s) => s.key));
      throwIfDbError(error);
      const rows = new Map(((data ?? []) as Array<{ key: SeriesKey; financial_year: string | null; next_value: number; updated_at: string }>).map((r) => [r.key, r]));
      for (const s of counterChanges) {
        const def = SERIES[s.key];
        const row = rows.get(s.key);
        if ((row?.updated_at ?? null) !== null && !sameInstant(row?.updated_at, s.updated_at)) {
          throw new ActionError(`The ${def.noun} counter moved since you opened this page (a number was issued). Reload to see the current number.`, {
            code: "conflict",
            fieldErrors: { [`series.${input.series.indexOf(s)}.next_value`]: ["Reload to see the current number."] },
          });
        }
        if (!row && s.updated_at) {
          throw new ActionError(`The ${def.noun} counter changed since you opened this page. Reload to see the current number.`, { code: "conflict" });
        }
        // The number the counter would give next: an FY-scoped series restarts at 1 in a new FY.
        const effective = !row ? 1 : def.fyScoped && row.financial_year !== fy ? 1 : row.next_value;
        if (s.next_value === effective) continue;
        if (s.next_value < effective) {
          if (effective - s.next_value > MAX_LOWERING) {
            throw new ActionError(`The ${def.noun} counter can be lowered by at most ${MAX_LOWERING.toLocaleString("en-IN")} at a time, so each number can be checked against those already issued.`, {
              fieldErrors: { [`series.${input.series.indexOf(s)}.next_value`]: [`Lower it by at most ${MAX_LOWERING.toLocaleString("en-IN")}.`] },
            });
          }
          const taken = await takenNumbers(ctx.supabase, s.key, prefixOf(s.key), fy, s.next_value, effective);
          if (taken.length) {
            const list = taken.slice(0, 3).join(", ") + (taken.length > 3 ? ` and ${taken.length - 3} more` : "");
            throw new ActionError(`${list} ${taken.length === 1 ? "is" : "are"} already issued, so the ${def.noun} counter can't go back to ${s.next_value}.`, {
              fieldErrors: { [`series.${input.series.indexOf(s)}.next_value`]: [`${taken[0]} is already issued.`] },
            });
          }
        } else if ((s.key === "invoice" || s.key === "credit_note") && effective > 1) {
          warnings.push(
            `GST Rule 46 asks for consecutive ${def.noun} numbers in a financial year. Moving from ${formatSeriesNumber(s.key, { seq: effective, prefix: prefixOf(s.key), fy })} to ${formatSeriesNumber(s.key, { seq: s.next_value, prefix: prefixOf(s.key), fy })} leaves a gap you may need to explain.`,
          );
        }
        plans.push({ key: s.key, next: s.next_value, current: { exists: Boolean(row), updated_at: row?.updated_at ?? null, next_value: row?.next_value ?? 1, financial_year: row?.financial_year ?? null } });
      }
    }

    // Prefixes first (they carry the firm_settings concurrency check), then the counters.
    const prefixChanges = diff(before as unknown as Patch, prefixPatch);
    let updated_at = before.updated_at;
    if (prefixChanges.length) {
      updated_at = await updateSettings(ctx, input.updated_at, Object.fromEntries(prefixChanges.map((c) => [c.field, prefixPatch[c.field]])));
    }

    const seriesOut: Array<{ key: SeriesKey; updated_at: string; next_value: number }> = [];
    const counterAudit: Change[] = [];
    for (const p of plans) {
      const def = SERIES[p.key];
      const values = { next_value: p.next, financial_year: def.fyScoped ? fy : null };
      if (p.current.exists) {
        const { data, error } = await ctx.supabase
          .from("number_series")
          .update(values)
          .eq("key", p.key)
          .eq("updated_at", p.current.updated_at as string)
          .select("updated_at, next_value")
          .maybeSingle();
        throwIfDbError(error);
        if (!data) {
          throw new ActionError(
            `${prefixChanges.length ? "The prefixes were saved, but the " : "The "}${def.noun} counter moved while saving (a number was issued). Reload and set it again.`,
            { code: "conflict" },
          );
        }
        seriesOut.push({ key: p.key, updated_at: (data as { updated_at: string }).updated_at, next_value: p.next });
      } else {
        const { data, error } = await ctx.supabase.from("number_series").insert({ key: p.key, ...values }).select("updated_at").single();
        throwIfDbError(error, { uniqueMessage: `The ${def.noun} counter was created while saving. Reload and set it again.` });
        seriesOut.push({ key: p.key, updated_at: (data as { updated_at: string }).updated_at, next_value: p.next });
      }
      counterAudit.push({ field: `number_series.${p.key}.next_value`, before: p.current.exists ? `${p.current.next_value} (${p.current.financial_year ?? "no FY"})` : null, after: `${p.next}${def.fyScoped ? ` (${fy})` : ""}` });
    }

    const changes = [...prefixChanges, ...counterAudit];
    if (changes.length) {
      await ctx.audit({ event: "config_change", resourceType: SETTINGS_RESOURCE, resourceId: "1", action: "settings.numbering.update", details: { section: "numbering", changes } });
    }
    return ok({ updated_at, changed: changes.length, series: seriesOut }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// Billing (§6.4, §7.21)
// -------------------------------------------------------------------------------------------------

export const saveBilling = defineAction(
  { name: "settings.billing.save", schema: BillingSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<SaveResult>> => {
    const limits = approvalLimitsFromForm(input);
    const { updated_at, changes } = await saveSettingsPanel(ctx, "billing", input.updated_at, {
      default_tax_rate: input.default_tax_rate,
      default_sac: input.default_sac,
      sac_by_service: sacMapToJson(input.sac_map),
      payment_terms_days: input.payment_terms_days,
      invoice_terms: input.invoice_terms,
      invoice_footer_note: input.invoice_footer_note,
      round_off_enabled: input.round_off_enabled,
      invoice_approval_limit: limits.invoice_approval_limit,
      quotation_approval_limit: limits.quotation_approval_limit,
      quotation_validity_days: input.quotation_validity_days,
      quotation_terms: input.quotation_terms,
      e_invoicing_applies: input.e_invoicing_applies,
      last_gstr1_reported_month: input.last_gstr1_reported_month,
    });
    return ok({ updated_at, changed: changes.length });
  },
);

// -------------------------------------------------------------------------------------------------
// Working hours and holidays (§7.11, §7.12)
// -------------------------------------------------------------------------------------------------

export const saveWorkingHours = defineAction(
  { name: "settings.working_hours.save", schema: WorkingHoursSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<SaveResult>> => {
    const { updated_at, changes } = await saveSettingsPanel(ctx, "working_hours", input.updated_at, {
      work_day_start: input.work_day_start,
      late_grace_minutes: input.late_grace_minutes,
      half_day_minutes: input.half_day_minutes,
      working_weekdays: input.working_weekdays,
      weekly_hours_target: input.weekly_hours_target,
      capacity_thresholds: input.capacity_thresholds,
    });
    return ok({ updated_at, changed: changes.length });
  },
);

export const addHoliday = defineAction(
  { name: "settings.holidays.add", schema: HolidaySchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ date: string }>> => {
    const { error } = await ctx.supabase.from("holidays").insert({ date: input.date, name: input.name });
    throwIfDbError(error, { uniqueField: "date", uniqueMessage: `${formatDate(input.date)} is already a holiday.` });
    await ctx.audit({
      event: "config_change",
      resourceType: "holidays",
      resourceId: input.date,
      action: "settings.holidays.add",
      details: { section: "working_hours", changes: [{ field: "holiday", before: null, after: `${input.date} ${input.name}` }] },
    });
    return ok({ date: input.date });
  },
);

export const removeHoliday = defineAction(
  { name: "settings.holidays.remove", schema: HolidayRemoveSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ date: string }>> => {
    const { data, error } = await ctx.supabase.from("holidays").delete().eq("date", input.date).select("date, name");
    throwIfDbError(error);
    const removed = ((data ?? []) as Array<{ date: string; name: string }>)[0];
    if (!removed) throw new ActionError("That holiday was already removed.", { code: "not_found" });
    await ctx.audit({
      event: "config_change",
      resourceType: "holidays",
      resourceId: input.date,
      action: "settings.holidays.remove",
      details: { section: "working_hours", changes: [{ field: "holiday", before: `${removed.date} ${removed.name}`, after: null }] },
    });
    return ok({ date: input.date });
  },
);

// -------------------------------------------------------------------------------------------------
// Reminders (§8)
// -------------------------------------------------------------------------------------------------

export const saveReminders = defineAction(
  { name: "settings.reminders.save", schema: RemindersSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<SaveResult>> => {
    const { updated_at, changes } = await saveSettingsPanel(ctx, "reminders", input.updated_at, {
      compliance_reminder_days: input.compliance_reminder_days,
      invoice_reminder_before_days: input.invoice_reminder_before_days,
      invoice_reminder_after_days: input.invoice_reminder_after_days,
      document_request_reminder_every_days: input.document_request_reminder_every_days,
      quotation_follow_up_days: input.quotation_follow_up_days,
      digest_enabled: input.digest_enabled,
    });
    return ok({ updated_at, changed: changes.length });
  },
);

// -------------------------------------------------------------------------------------------------
// Diagnostics (§7.24): gated on the Supabase session alone, so it answers when the database is
// broken. Not a mutation, so not defineAction (which reads profiles); same never-throw contract.
// -------------------------------------------------------------------------------------------------

const CheckIdSchema = z.string().max(40);

export async function runDiagnosticCheck(id: string): Promise<ActionResult<DiagnosticResult>> {
  try {
    const parsed = CheckIdSchema.safeParse(id);
    if (!parsed.success || !isDiagnosticCheckId(parsed.data)) return { ok: false, error: "Unknown check.", code: "validation" };
    const access = await diagnosticsAccess();
    if (!access.ok) {
      return { ok: false, error: access.message, code: access.reason === "anonymous" ? "unauthenticated" : access.reason === "forbidden" ? "forbidden" : "unexpected", ref: access.ref };
    }
    return ok(await runCheck(parsed.data, access.supabase));
  } catch (err) {
    const ref = logUnexpected(err, { source: "action:settings.diagnostics.run" });
    return { ok: false, error: `The check couldn't run. Quote Ref ${ref}.`, code: "unexpected", ref };
  }
}
