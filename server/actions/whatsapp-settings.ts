"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok } from "@/lib/result";
import { formatDate, formatTime } from "@/lib/format";
import type { WhatsAppNumberKind } from "@/lib/domain/whatsapp";
import { FirmNumberSchema, NumberIdSchema, WhatsAppSettingsSchema } from "@/lib/schemas/whatsapp";
import { WHATSAPP_SETTINGS_COLUMNS, getWhatsAppFirmSettings } from "@/lib/data/whatsapp";
import { getNamesByProfile } from "@/lib/data/people";

/**
 * Settings → WhatsApp (§7.21, §7.25): the firm-wide WhatsApp settings, the house rules and the
 * firm's WhatsApp numbers. Partner only (`roles: ["partner"]`; RLS lets only Partners update
 * firm_settings and firm_whatsapp_numbers, §4.6). Managers and Employees read the page.
 *
 * Every save carries the row's `updated_at` as loaded and is refused with who changed it and when
 * if it moved (§13), writes only what changed, and audits a before/after summary (config_change).
 *
 * Recording a linked-devices review is the number's custodian's job (house rule 5) as well as a
 * Partner's, so that one action is open to staff; the database function checks who.
 */

type Change = { field: string; before: unknown; after: unknown };

function same(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => (v === undefined || v === "" ? null : Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : typeof v === "number" ? String(v) : v);
  return n(a) === n(b) || JSON.stringify(n(a)) === JSON.stringify(n(b));
}

function short(v: unknown): unknown {
  return typeof v === "string" && v.length > 160 ? `${v.slice(0, 159)}… (${v.length} characters)` : v;
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>, mask: (field: string, v: unknown) => unknown = (_f, v) => short(v)): Change[] {
  return Object.entries(after)
    .filter(([field, value]) => !same(before[field], value))
    .map(([field, value]) => ({ field, before: mask(field, before[field] ?? null), after: mask(field, value ?? null) }));
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || Date.parse(a) === Date.parse(b);
}

async function conflictMessage(ctx: ActionContext, at: string, by: string | null): Promise<string> {
  let name: string | null = null;
  try {
    if (by) name = (await getNamesByProfile(ctx.supabase, [by])).get(by) ?? null;
  } catch {
    name = null;
  }
  const when = formatDate(at) === formatDate(new Date()) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`;
  return `Changed by ${name ?? "someone else"} at ${when}. Reload to see their changes.`;
}

async function loadFirmSettings(ctx: ActionContext): Promise<Record<string, unknown> & { updated_at: string; updated_by: string | null }> {
  const { data, error } = await ctx.supabase
    .from("firm_settings")
    .select([...WHATSAPP_SETTINGS_COLUMNS, "updated_at", "updated_by"].join(", "))
    .eq("id", 1)
    .maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("The firm's settings row is missing. Ask whoever set up the database to run the database seed.", { code: "not_found" });
  return data as unknown as Record<string, unknown> & { updated_at: string; updated_by: string | null };
}

async function saveFirmSettings(ctx: ActionContext, section: string, loaded: string, patch: Record<string, unknown>) {
  const before = await loadFirmSettings(ctx);
  if (!sameInstant(before.updated_at, loaded)) throw new ActionError(await conflictMessage(ctx, before.updated_at, before.updated_by), { code: "conflict" });
  const changes = diff(before, patch);
  if (changes.length === 0) return { updated_at: before.updated_at, changed: 0 };
  const { data, error } = await ctx.supabase
    .from("firm_settings")
    .update({ ...patch, updated_by: ctx.user.id })
    .eq("id", 1)
    .eq("updated_at", before.updated_at)
    .select("updated_at")
    .maybeSingle();
  throwIfDbError(error);
  if (!data) {
    const fresh = await loadFirmSettings(ctx);
    throw new ActionError(await conflictMessage(ctx, fresh.updated_at, fresh.updated_by), { code: "conflict" });
  }
  await ctx.audit({ event: "config_change", resourceType: "firm_settings", resourceId: "1", action: `settings.${section}`, details: { section, changes } });
  return { updated_at: (data as { updated_at: string }).updated_at, changed: changes.length };
}

/** Country code, name format, signature, the browser window for Employees and the house rules. */
export const saveWhatsAppSettings = defineAction({ name: "settings.whatsapp", schema: WhatsAppSettingsSchema, roles: ["partner"] }, async (input, ctx) => {
  const { updated_at, ...patch } = input;
  return ok(await saveFirmSettings(ctx, "whatsapp", updated_at, patch));
});

const NUMBER_FIELDS = [
  "label",
  "number",
  "kind",
  "employee_id",
  "custodian_employee_id",
  "in_every_client_group",
  "group_admin",
  "shared",
  "two_step_verification_on",
  "is_active",
] as const;

/**
 * firm_whatsapp_numbers.usable_by said who could open the number in TaxWise Desktop, which is gone.
 * The column stays (not null, and the firm_whatsapp_numbers_guard trigger wants {partner} on a
 * Partner's own number), so a new number gets its kind's §5.13 default and a number made a
 * Partner's own gets {partner}.
 */
const USABLE_BY: Record<WhatsAppNumberKind, string[]> = {
  partner: ["partner"],
  managers_office: ["partner", "manager"],
  staff_office: ["partner", "manager", "employee"],
  other: ["partner"],
};

function maskNumber(field: string, v: unknown): unknown {
  if (field === "number" && typeof v === "string" && v.length > 4) return `••••${v.slice(-4)}`;
  return v;
}

function uniqueMessage(error: { code?: string; message?: string } | null): string | null {
  if (!error || error.code !== "23505") return null;
  if ((error.message ?? "").includes("number")) return "That number is already saved as another firm number.";
  return "Another firm number already has this label.";
}

/** Add or edit one of the firm's WhatsApp numbers (§5.13, §7.21). */
export const saveFirmWhatsAppNumber = defineAction({ name: "settings.whatsapp_number", schema: FirmNumberSchema, roles: ["partner"] }, async (input, ctx) => {
  const settings = await getWhatsAppFirmSettings(ctx.supabase);
  if (input.country_code !== settings.countryCode) {
    return fail("The default country code changed while you were editing. Reload the page and enter the number again.", { code: "conflict" });
  }
  const values: Record<string, unknown> = Object.fromEntries(NUMBER_FIELDS.map((f) => [f, input[f]]));

  if (!input.id) {
    const { data, error } = await ctx.supabase
      .from("firm_whatsapp_numbers")
      .insert({ ...values, usable_by: USABLE_BY[input.kind] } as never)
      .select("id, updated_at")
      .single();
    const dup = uniqueMessage(error);
    if (dup) return fail(dup, { code: "conflict", fieldErrors: { [dup.includes("number") ? "number" : "label"]: [dup] } });
    throwIfDbError(error);
    await ctx.audit({
      event: "config_change",
      resourceType: "firm_whatsapp_number",
      resourceId: data!.id,
      action: "settings.whatsapp_number_add",
      details: { label: input.label, kind: input.kind, number: maskNumber("number", input.number), active: input.is_active },
    });
    return ok({ id: data!.id, updated_at: data!.updated_at, changed: 1 });
  }

  const { data: before, error: loadError } = await ctx.supabase.from("firm_whatsapp_numbers").select(`${NUMBER_FIELDS.join(", ")}, updated_at`).eq("id", input.id).maybeSingle();
  throwIfDbError(loadError);
  if (!before) return fail("That number is no longer listed. Reload the page.", { code: "not_found" });
  const row = before as unknown as Record<string, unknown> & { updated_at: string };
  if (!sameInstant(row.updated_at, input.updated_at)) return fail("This number was changed by someone else. Reload to see their changes.", { code: "conflict" });
  const changes = diff(row, values, maskNumber);
  if (changes.length === 0) return ok({ id: input.id, updated_at: row.updated_at, changed: 0 });

  const { data, error } = await ctx.supabase
    .from("firm_whatsapp_numbers")
    .update((input.kind === "partner" ? { ...values, usable_by: USABLE_BY.partner } : values) as never)
    .eq("id", input.id)
    .eq("updated_at", row.updated_at)
    .select("updated_at")
    .maybeSingle();
  const dup = uniqueMessage(error);
  if (dup) return fail(dup, { code: "conflict", fieldErrors: { [dup.includes("number") ? "number" : "label"]: [dup] } });
  throwIfDbError(error);
  if (!data) return fail("This number was changed by someone else. Reload to see their changes.", { code: "conflict" });
  await ctx.audit({ event: "config_change", resourceType: "firm_whatsapp_number", resourceId: input.id, action: "settings.whatsapp_number", details: { label: input.label, changes } });
  return ok({ id: input.id, updated_at: data.updated_at, changed: changes.length });
});

/** House rule 5: the custodian (or a Partner) records that the phone's Linked devices list was checked. */
export const recordWhatsAppDevicesReview = defineAction({ name: "settings.whatsapp_devices_review", schema: NumberIdSchema, roles: ["partner", "manager", "employee"] }, async (input, ctx) => {
  const { data, error } = await ctx.supabase.rpc("record_whatsapp_devices_review", { p_number_id: input.numberId });
  throwIfDbError(error);
  const r = data as { label: string; reviewed_at: string; previous: string | null };
  await ctx.audit({ event: "config_change", resourceType: "firm_whatsapp_number", resourceId: input.numberId, action: "settings.whatsapp_devices_review", details: { label: r.label, previous: r.previous } });
  return ok({ reviewedAt: r.reviewed_at });
});
