"use server";

import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, ok, type ActionResult } from "@/lib/result";
import { formatDate } from "@/lib/format";
import { compareDates, todayIST, type DateString } from "@/lib/domain/fy";
import { applyOverride, removeOverride as unapplyOverride, type DueDateOverride, type OverridableEvent } from "@/lib/domain/statutory-calendar";
import type { ComplianceStatus, ComplianceWorkflow } from "@/lib/domain/enums";
import {
  ConcordanceSchema,
  DueDateRuleChangeSchema,
  MarkReviewedSchema,
  MarkVerifiedSchema,
  OverrideSchema,
  ParameterAddSchema,
  ParameterChangeSchema,
  planSupersede,
  summariseParameterValue,
} from "@/lib/schemas/law";
import type { ServerSupabase } from "@/lib/supabase/server";

/**
 * Settings → Law & rules (§5.12, §7.21). Partner only. Statutory numbers are data, and their history
 * is never overwritten: a change from a date closes the row in force the day before (`effective_to`)
 * and adds a new row. Every write leaves a `config_change` audit row, which is the page's change log.
 *
 * Two-step changes (close + insert) run under the Partner's session; if the insert is refused, the
 * closed row is reopened so nothing is lost. A government extension moves every matching unfiled
 * compliance event through `apply_due_date_override(p_override_id)` when the database has it, and
 * otherwise here, with the same rules (lib/domain/statutory-calendar applyOverride).
 */

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a === b || Date.parse(a) === Date.parse(b));

const STALE = "This row changed since you opened it. Reload to see the current version.";

function missingColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(error.message ?? ""));
}

function missingFunction(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? ""));
}

async function audit(ctx: ActionContext, resourceType: string, resourceId: string | null, action: string, details: Record<string, unknown>) {
  await ctx.audit({ event: "config_change", resourceType, resourceId, action, details });
}

// -------------------------------------------------------------------------------------------------
// Statutory parameters
// -------------------------------------------------------------------------------------------------

interface ParameterDbRow {
  id: string;
  key: string;
  value: unknown;
  effective_from: DateString;
  effective_to: DateString | null;
  statute: string | null;
  section_ref: string | null;
  source_ref: string | null;
  notes: string | null;
  verified: boolean;
  updated_at: string;
}

export const changeParameter = defineAction(
  { name: "law.parameter.change", schema: ParameterChangeSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase
      .from("statutory_parameters")
      .select("id, key, value, effective_from, effective_to, statute, section_ref, source_ref, notes, verified, updated_at")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(error);
    const row = data as ParameterDbRow | null;
    if (!row) throw new ActionError("That parameter no longer exists. Reload the page.", { code: "not_found" });
    if (!sameInstant(row.updated_at, input.updated_at)) throw new ActionError(STALE, { code: "conflict" });

    const plan = planSupersede(row, input.effective_from);
    if (!plan.ok) throw new ActionError(plan.error, { fieldErrors: { effective_from: [plan.error] } });

    const closed = await ctx.supabase
      .from("statutory_parameters")
      .update({ effective_to: plan.closeOldOn })
      .eq("id", row.id)
      .eq("updated_at", input.updated_at)
      .select("id")
      .maybeSingle();
    throwIfDbError(closed.error);
    if (!closed.data) throw new ActionError(STALE, { code: "conflict" });

    const today = todayIST();
    const inserted = await ctx.supabase
      .from("statutory_parameters")
      .insert({
        key: row.key,
        value: input.value,
        effective_from: input.effective_from,
        effective_to: row.effective_to,
        statute: input.statute,
        section_ref: input.section_ref,
        source_ref: input.source_ref,
        notes: input.notes,
        verified: input.verified,
        verified_by: input.verified ? ctx.user.id : null,
        verified_on: input.verified ? today : null,
      })
      .select("id")
      .single();
    if (inserted.error) {
      // Put the row back as it was, so the change is all or nothing.
      await ctx.supabase.from("statutory_parameters").update({ effective_to: row.effective_to }).eq("id", row.id);
      throwIfDbError(inserted.error, {
        uniqueField: "effective_from",
        uniqueMessage: `There is already a row for ${row.key} from ${formatDate(input.effective_from)}.`,
      });
    }
    const newId = (inserted.data as { id: string }).id;
    await audit(ctx, "statutory_parameters", newId, "law.parameter.change", {
      key: row.key,
      supersedes: row.id,
      before: { value: summariseParameterValue(row.value, 120), effective_from: row.effective_from, effective_to: row.effective_to },
      after: { value: summariseParameterValue(input.value, 120), effective_from: input.effective_from, effective_to: row.effective_to },
      closed_old_on: plan.closeOldOn,
      source_ref: input.source_ref,
      verified: input.verified,
    });
    return ok({ id: newId });
  },
);

export const addParameter = defineAction(
  { name: "law.parameter.add", schema: ParameterAddSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    // No two rows for one key may be in force on the same day.
    let overlap = ctx.supabase
      .from("statutory_parameters")
      .select("id, effective_from, effective_to")
      .eq("key", input.key)
      .or(`effective_to.is.null,effective_to.gte.${input.effective_from}`);
    if (input.effective_to) overlap = overlap.lte("effective_from", input.effective_to);
    const existing = await overlap.limit(1);
    throwIfDbError(existing.error);
    const clash = ((existing.data ?? []) as Array<{ effective_from: string; effective_to: string | null }>)[0];
    if (clash) {
      const msg = `${input.key} already has a value in force from ${formatDate(clash.effective_from)}${clash.effective_to ? ` to ${formatDate(clash.effective_to)}` : ""}. Change that row from a date instead.`;
      throw new ActionError(msg, { fieldErrors: { key: [msg] } });
    }
    const today = todayIST();
    const { data, error } = await ctx.supabase
      .from("statutory_parameters")
      .insert({
        key: input.key,
        value: input.value,
        effective_from: input.effective_from,
        effective_to: input.effective_to,
        statute: input.statute,
        section_ref: input.section_ref,
        source_ref: input.source_ref,
        notes: input.notes,
        verified: input.verified,
        verified_by: input.verified ? ctx.user.id : null,
        verified_on: input.verified ? today : null,
      })
      .select("id")
      .single();
    throwIfDbError(error, { uniqueField: "effective_from", uniqueMessage: `There is already a row for ${input.key} from ${formatDate(input.effective_from)}.` });
    const id = (data as { id: string }).id;
    await audit(ctx, "statutory_parameters", id, "law.parameter.add", {
      key: input.key,
      after: { value: summariseParameterValue(input.value, 120), effective_from: input.effective_from, effective_to: input.effective_to },
      source_ref: input.source_ref,
      verified: input.verified,
    });
    return ok({ id });
  },
);

// -------------------------------------------------------------------------------------------------
// Verification and the review stamp
// -------------------------------------------------------------------------------------------------

export const markVerified = defineAction(
  { name: "law.verify", schema: MarkVerifiedSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const today = todayIST();
    const full = { verified: true, verified_by: ctx.user.id, verified_on: today };
    let res = await ctx.supabase.from(input.table).update(full).eq("id", input.id).eq("updated_at", input.updated_at).select("id").maybeSingle();
    if (input.table === "section_concordance" && missingColumn(res.error)) {
      // This table may not carry verified_by / verified_on yet; the audit row records who and when.
      res = await ctx.supabase.from(input.table).update({ verified: true }).eq("id", input.id).eq("updated_at", input.updated_at).select("id").maybeSingle();
    }
    throwIfDbError(res.error);
    if (!res.data) throw new ActionError(STALE, { code: "conflict" });
    await audit(ctx, input.table, input.id, "law.verify", { verified_by: ctx.user.fullName, verified_on: today });
    return ok({ id: input.id });
  },
);

export const markLawReviewed = defineAction(
  { name: "law.review", schema: MarkReviewedSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ at: string }>> => {
    const at = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from("firm_settings")
      // updated_by too: a settings form open elsewhere then names the reviewer in its conflict message.
      .update({ law_last_reviewed_at: at, law_last_reviewed_by: ctx.user.id, updated_by: ctx.user.id })
      .eq("id", 1)
      .select("id")
      .maybeSingle();
    throwIfDbError(error);
    if (!data) throw new ActionError("The firm's settings row is missing. Ask whoever set up the database to run the database seed.", { code: "not_found" });

    const today = todayIST();
    const awaiting = await Promise.all([
      ctx.supabase.from("statutory_parameters").select("id", { count: "exact", head: true }).eq("verified", false).or(`effective_to.is.null,effective_to.gte.${today}`),
      ctx.supabase.from("due_date_rules").select("id", { count: "exact", head: true }).eq("verified", false).or(`effective_to.is.null,effective_to.gte.${today}`),
      ctx.supabase.from("section_concordance").select("id", { count: "exact", head: true }).eq("verified", false),
    ]);
    const open = awaiting.reduce((n, r) => n + (r.error ? 0 : (r.count ?? 0)), 0);
    await audit(ctx, "law_review", "1", "law.review", { note: input.note, awaiting_confirmation: open });
    const warnings =
      open > 0
        ? [`${open.toLocaleString("en-IN")} item${open === 1 ? " is" : "s are"} still awaiting partner confirmation. Every [verify] item must be confirmed before go-live.`]
        : [];
    return ok({ at }, warnings);
  },
);

// -------------------------------------------------------------------------------------------------
// Due-date rules
// -------------------------------------------------------------------------------------------------

export const changeDueDateRule = defineAction(
  { name: "law.rule.change", schema: DueDateRuleChangeSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string; code: string }>> => {
    const { data, error } = await ctx.supabase
      .from("due_date_rules")
      .select("id, code, title, compliance_type, form_code, applies_to, frequency, rule, reminder_days, effective_from, effective_to, source_ref, is_active, updated_at")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(error);
    const row = data as {
      id: string;
      code: string;
      title: string;
      compliance_type: string;
      form_code: string | null;
      applies_to: unknown;
      frequency: string;
      rule: unknown;
      reminder_days: number;
      effective_from: DateString;
      effective_to: DateString | null;
      source_ref: string | null;
      is_active: boolean;
      updated_at: string;
    } | null;
    if (!row) throw new ActionError("That rule no longer exists. Reload the page.", { code: "not_found" });
    if (!sameInstant(row.updated_at, input.updated_at)) throw new ActionError(STALE, { code: "conflict" });
    if (input.new_code === row.code) {
      throw new ActionError("Give the new version its own code.", { fieldErrors: { new_code: ["Give the new version its own code, like " + row.code + "_" + input.effective_from.slice(0, 4) + "."] } });
    }
    const plan = planSupersede(row, input.effective_from);
    if (!plan.ok) throw new ActionError(plan.error, { fieldErrors: { effective_from: [plan.error] } });

    const closed = await ctx.supabase
      .from("due_date_rules")
      .update({ effective_to: plan.closeOldOn })
      .eq("id", row.id)
      .eq("updated_at", input.updated_at)
      .select("id")
      .maybeSingle();
    throwIfDbError(closed.error);
    if (!closed.data) throw new ActionError(STALE, { code: "conflict" });

    const today = todayIST();
    const inserted = await ctx.supabase
      .from("due_date_rules")
      .insert({
        code: input.new_code,
        title: input.title,
        compliance_type: row.compliance_type,
        form_code: input.form_code,
        applies_to: input.applies_to,
        frequency: input.frequency,
        rule: input.rule,
        reminder_days: input.reminder_days,
        effective_from: input.effective_from,
        effective_to: row.effective_to,
        source_ref: input.source_ref,
        is_active: row.is_active,
        verified: input.verified,
        verified_by: input.verified ? ctx.user.id : null,
        verified_on: input.verified ? today : null,
      })
      .select("id")
      .single();
    if (inserted.error) {
      await ctx.supabase.from("due_date_rules").update({ effective_to: row.effective_to }).eq("id", row.id);
      throwIfDbError(inserted.error, { uniqueField: "new_code", uniqueMessage: `The code ${input.new_code} is already used. Choose another.` });
    }
    const newId = (inserted.data as { id: string }).id;
    await audit(ctx, "due_date_rules", newId, "law.rule.change", {
      supersedes: { id: row.id, code: row.code },
      code: input.new_code,
      before: { title: row.title, rule: row.rule, applies_to: row.applies_to, reminder_days: row.reminder_days, effective_from: row.effective_from, effective_to: row.effective_to },
      after: { title: input.title, rule: input.rule, applies_to: input.applies_to, reminder_days: input.reminder_days, effective_from: input.effective_from },
      closed_old_on: plan.closeOldOn,
      source_ref: input.source_ref,
    });
    return ok({ id: newId, code: input.new_code });
  },
);

// -------------------------------------------------------------------------------------------------
// Government extensions (due_date_overrides)
// -------------------------------------------------------------------------------------------------

interface EventRow {
  id: string;
  rule_code: string | null;
  filing_period: string | null;
  due_date: DateString;
  original_due_date: DateString | null;
  status: ComplianceStatus;
  workflow_status: ComplianceWorkflow;
  override_id: string | null;
}

type MovableEvent = OverridableEvent & { id: string };

function toMovable(r: EventRow): MovableEvent {
  return {
    id: r.id,
    ruleCode: r.rule_code,
    filingPeriod: r.filing_period,
    dueDate: r.due_date,
    originalDueDate: r.original_due_date,
    status: r.status,
    workflowStatus: r.workflow_status,
    overrideId: r.override_id,
  };
}

const EVENT_COLUMNS = "id, rule_code, filing_period, due_date, original_due_date, status, workflow_status, override_id";
const MAX_EVENTS = 5000;

async function runInBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/**
 * Moves the events an extension covers. Returns how many moved and how many had a statutory date
 * different from the circular's original date (moved anyway; worth a look).
 */
async function moveEvents(
  ctx: ActionContext,
  override: DueDateOverride & { id: string },
  direction: "apply" | "remove",
): Promise<{ moved: number; mismatched: number; viaDatabase: boolean }> {
  if (direction === "apply") {
    const rpc = await ctx.supabase.rpc("apply_due_date_override", { p_override_id: override.id });
    if (!rpc.error) {
      const d = rpc.data as unknown;
      const moved = typeof d === "number" ? d : d && typeof d === "object" && "moved" in d ? Number((d as { moved: unknown }).moved) || 0 : 0;
      return { moved, mismatched: 0, viaDatabase: true };
    }
    if (!missingFunction(rpc.error)) throwIfDbError(rpc.error);
  }

  let q = ctx.supabase.from("compliance_events").select(EVENT_COLUMNS).eq("rule_code", override.ruleCode).eq("filing_period", override.periodLabel).eq("status", "pending");
  if (direction === "remove") q = q.eq("override_id", override.id);
  const { data, error } = await q.limit(MAX_EVENTS);
  throwIfDbError(error);
  const events = ((data ?? []) as EventRow[]).map(toMovable);
  const plan = direction === "apply" ? applyOverride(events, override) : unapplyOverride(events, override);

  const done: typeof plan.moved = [];
  await runInBatches(plan.moved, 10, async (m) => {
    const res = await ctx.supabase
      .from("compliance_events")
      .update({
        due_date: m.after.dueDate,
        original_due_date: m.after.originalDueDate ?? null,
        override_id: direction === "apply" ? override.id : null,
        reminder_sent_at: null, // the reminder is re-planned from the new date (§5.12)
      })
      .eq("id", m.before.id)
      .eq("due_date", m.before.dueDate)
      .eq("status", "pending")
      .select("id");
    throwIfDbError(res.error);
    if (((res.data ?? []) as unknown[]).length > 0) done.push(m);
  });

  if (done.length) {
    ctx.after(
      "Record the move on each event's history",
      async () => {
        const rows = done.map((m) => ({
          entity_type: "compliance_event",
          entity_id: m.before.id,
          action: direction === "apply" ? "due_date_extended" : "due_date_extension_removed",
          description: m.note,
          user_id: ctx.user.id,
          user_name: ctx.user.fullName,
          metadata: { override_id: override.id, source_ref: override.sourceRef, from: m.before.dueDate, to: m.after.dueDate },
        }));
        for (let i = 0; i < rows.length; i += 200) {
          const { error: e } = await ctx.supabase.from("activity_logs").insert(rows.slice(i, i + 200));
          if (e) throw e;
        }
      },
      "The events moved, but their history lines weren't written. The change log on this page still shows the extension.",
    );
  }
  return { moved: done.length, mismatched: done.filter((m) => m.originalMismatch).length, viaDatabase: false };
}

async function ruleExists(supabase: ServerSupabase, code: string): Promise<{ code: string; title: string } | null> {
  const { data, error } = await supabase.from("due_date_rules").select("code, title").eq("code", code).maybeSingle();
  throwIfDbError(error);
  return (data as { code: string; title: string } | null) ?? null;
}

export const addOverride = defineAction(
  { name: "law.override.add", schema: OverrideSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string; moved: number }>> => {
    const rule = await ruleExists(ctx.supabase, input.rule_code);
    if (!rule) throw new ActionError("Choose a rule from the list.", { fieldErrors: { rule_code: ["Choose a rule from the list."] } });

    const { data, error } = await ctx.supabase
      .from("due_date_overrides")
      .insert({
        rule_code: input.rule_code,
        period_label: input.period_label,
        original_due: input.original_due,
        extended_due: input.extended_due,
        scope: input.scope,
        source_ref: input.source_ref,
        created_by: ctx.user.id,
      })
      .select("id")
      .single();
    throwIfDbError(error, {
      uniqueField: "period_label",
      uniqueMessage: `An extension for ${rule.code} · ${input.period_label} is already recorded. Remove it first to enter a different date.`,
    });
    const id = (data as { id: string }).id;
    const override: DueDateOverride & { id: string } = {
      id,
      ruleCode: input.rule_code,
      periodLabel: input.period_label,
      originalDue: input.original_due,
      extendedDue: input.extended_due,
      scope: input.scope,
      sourceRef: input.source_ref,
    };

    await audit(ctx, "due_date_overrides", id, "law.override.add", {
      rule_code: input.rule_code,
      period_label: input.period_label,
      original_due: input.original_due,
      extended_due: input.extended_due,
      source_ref: input.source_ref,
    });

    // The extension is saved; moving the events must not undo that (§0.1 rule 5).
    const warnings: string[] = [];
    let moved = 0;
    try {
      const r = await moveEvents(ctx, override, "apply");
      moved = r.moved;
      if (r.moved === 0) {
        warnings.push(
          `The extension is saved, but no unfiled event matched ${rule.code} for "${input.period_label}", so nothing moved. Check the period is written exactly as on the events (for example Sep 2026, Q2 2026-27 or AY 2026-27). Events generated later pick the extension up.`,
        );
      }
      if (r.mismatched > 0) {
        warnings.push(
          `${r.mismatched} moved event${r.mismatched === 1 ? " had" : "s had"} a due date other than ${formatDate(input.original_due)} before the move. Check them in Filings.`,
        );
      }
      await audit(ctx, "due_date_overrides", id, "law.override.applied", { moved: r.moved, mismatched: r.mismatched, via: r.viaDatabase ? "database" : "app" });
    } catch (err) {
      if (err instanceof ActionError) warnings.push(`The extension is saved, but the events didn't move: ${err.message}`);
      else throw err;
    }
    if (compareDates(input.extended_due, todayIST()) < 0) {
      warnings.push(`The extended date (${formatDate(input.extended_due)}) has already passed: moved events still show as overdue.`);
    }
    return ok({ id, moved }, warnings);
  },
);

const RemoveOverrideSchema = z.object({ id: z.uuid({ error: "Reload the page and try again." }) });

export const removeOverride = defineAction(
  { name: "law.override.remove", schema: RemoveOverrideSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ moved: number }>> => {
    const { data, error } = await ctx.supabase
      .from("due_date_overrides")
      .select("id, rule_code, period_label, original_due, extended_due, scope, source_ref")
      .eq("id", input.id)
      .maybeSingle();
    throwIfDbError(error);
    const row = data as { id: string; rule_code: string; period_label: string; original_due: string; extended_due: string; scope: string | null; source_ref: string } | null;
    if (!row) throw new ActionError("That extension was already removed.", { code: "not_found" });
    const override: DueDateOverride & { id: string } = {
      id: row.id,
      ruleCode: row.rule_code,
      periodLabel: row.period_label,
      originalDue: row.original_due,
      extendedDue: row.extended_due,
      scope: row.scope,
      sourceRef: row.source_ref,
    };
    // Events first: once the row is gone, nothing links them to it.
    const r = await moveEvents(ctx, override, "remove");
    const del = await ctx.supabase.from("due_date_overrides").delete().eq("id", row.id).select("id");
    throwIfDbError(del.error);
    await audit(ctx, "due_date_overrides", row.id, "law.override.remove", {
      rule_code: row.rule_code,
      period_label: row.period_label,
      original_due: row.original_due,
      extended_due: row.extended_due,
      source_ref: row.source_ref,
      moved_back: r.moved,
    });
    return ok({ moved: r.moved });
  },
);

// -------------------------------------------------------------------------------------------------
// Section concordance (1961 ↔ 2025)
// -------------------------------------------------------------------------------------------------

export const saveConcordance = defineAction(
  { name: "law.concordance.save", schema: ConcordanceSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const today = todayIST();
    const base = {
      topic: input.topic,
      old_section: input.old_section,
      new_section: input.new_section,
      old_form: input.old_form,
      new_form: input.new_form,
      source_ref: input.source_ref,
      verified: input.verified,
    };
    const stamp = { verified_by: input.verified ? ctx.user.id : null, verified_on: input.verified ? today : null };

    if (input.id) {
      const before = await ctx.supabase.from("section_concordance").select("*").eq("id", input.id).maybeSingle();
      throwIfDbError(before.error);
      if (!before.data) throw new ActionError("That row no longer exists. Reload the page.", { code: "not_found" });
      let res = await ctx.supabase
        .from("section_concordance")
        .update({ ...base, ...stamp })
        .eq("id", input.id)
        .eq("updated_at", input.updated_at as string)
        .select("id")
        .maybeSingle();
      if (missingColumn(res.error)) {
        res = await ctx.supabase.from("section_concordance").update(base).eq("id", input.id).eq("updated_at", input.updated_at as string).select("id").maybeSingle();
      }
      throwIfDbError(res.error);
      if (!res.data) throw new ActionError(STALE, { code: "conflict" });
      const b = before.data as Record<string, unknown>;
      await audit(ctx, "section_concordance", input.id, "law.concordance.update", {
        topic: input.topic,
        before: { old_section: b.old_section, new_section: b.new_section, old_form: b.old_form, new_form: b.new_form, verified: b.verified },
        after: { old_section: input.old_section, new_section: input.new_section, old_form: input.old_form, new_form: input.new_form, verified: input.verified },
      });
      return ok({ id: input.id });
    }

    let res = await ctx.supabase.from("section_concordance").insert({ ...base, ...stamp }).select("id").single();
    if (missingColumn(res.error)) res = await ctx.supabase.from("section_concordance").insert(base).select("id").single();
    throwIfDbError(res.error, { uniqueField: "topic", uniqueMessage: "That topic is already in the concordance." });
    const id = (res.data as { id: string }).id;
    await audit(ctx, "section_concordance", id, "law.concordance.add", { topic: input.topic, after: base });
    return ok({ id });
  },
);
