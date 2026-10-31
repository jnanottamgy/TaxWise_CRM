import "server-only";

import type { Json } from "@/lib/database.types";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { ServiceType } from "@/lib/domain/enums";
import { compareDates, type DateString } from "@/lib/domain/fy";
import { parseAmount, paiseToDecimalString } from "@/lib/domain/money";
import { resolveScaleParams } from "@/lib/domain/scale";
import {
  CALENDAR_DEFAULTS,
  generateEvents,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  resolveCalendarParams,
  toComplianceEventInsert,
  type CalendarEvent,
  type CalendarParams,
  type DueDateOverride,
  type DueDateRule,
} from "@/lib/domain/statutory-calendar";
import { loadScaleParameterRows } from "@/lib/data/clients";
import {
  calendarProfileFor,
  gstFrequencyLock,
  initialTasks,
  kycCategoryFor,
  schemeDecisionFor,
  serviceName,
  taxAuditFor,
  type CalendarInputs,
  type OnboardingData,
  type PreviewEvent,
  type ScaleContext,
} from "@/lib/schemas/onboarding";
import { isWhatsAppNumber } from "@/lib/schemas/clients";
import type { KycEngagementType } from "@/lib/schemas/client-kyc";
import type { AuditKind } from "@/lib/schemas/onboarding";

/** The wizard's audit kinds as KYC engagement-type codes (client_kyc.engagement_types, §6.8), as Client 360's KYC form stores them. */
const AUDIT_KIND_ENGAGEMENT: Record<AuditKind, KycEngagementType> = {
  statutory: "statutory_companies_act",
  tax: "tax_audit",
  gst: "gst_audit",
  internal: "internal",
};
import { log } from "@/lib/log";

/**
 * The server half of the onboarding wizard (§7.3.2): the statutory calendar engine loaded from the
 * law tables (§5.12: due_date_rules, due_date_overrides, statutory_parameters), the 12-month
 * deadline preview, and the onboard_client payload (0111). The events are generated here with
 * lib/domain/statutory-calendar.ts (never trusted from the browser) and inserted by the same
 * transaction that creates the client.
 */

export type CalendarEngine = {
  rules: DueDateRule[];
  overrides: DueDateOverride[];
  params: CalendarParams;
  /** Rules that couldn't be read (shown to nobody; logged for the Law & rules page). */
  skipped: string[];
};

/** Reads the rules, extensions and parameters in force (§5.12). Unreadable rows are skipped and logged. */
export async function loadCalendarEngine(supabase: ServerSupabase, today: DateString): Promise<CalendarEngine> {
  const [rules, overrides, paramRows] = await Promise.all([
    supabase
      .from("due_date_rules")
      .select("code, title, compliance_type, form_code, applies_to, frequency, rule, reminder_days, effective_from, effective_to, source_ref, verified, is_active")
      .eq("is_active", true),
    supabase.from("due_date_overrides").select("id, rule_code, period_label, original_due, extended_due, scope, source_ref"),
    loadScaleParameterRows(supabase),
  ]);
  if (rules.error) throw rules.error;
  if (overrides.error) throw overrides.error;
  const skipped: string[] = [];
  const parsedRules: DueDateRule[] = [];
  for (const row of rules.data ?? []) {
    const r = parseDueDateRuleRow(row);
    if (r.ok) parsedRules.push(r.value);
    else skipped.push(r.error);
  }
  const parsedOverrides: DueDateOverride[] = [];
  for (const row of overrides.data ?? []) {
    const r = parseDueDateOverrideRow(row);
    if (r.ok) parsedOverrides.push(r.value);
    else skipped.push(r.error);
  }
  if (skipped.length) log("warn", "due date rules skipped while generating deadlines", { source: "server:onboarding", skipped });
  const scale = resolveScaleParams(paramRows, today);
  const params: CalendarParams = { ...resolveCalendarParams(paramRows, today, CALENDAR_DEFAULTS), scale: { qrmpMaxTurnoverPaise: scale.qrmpMaxTurnoverPaise } };
  return { rules: parsedRules, overrides: parsedOverrides, params, skipped };
}

/** The new client's statutory events (§6.7): monthly/quarterly for 13 months, annual to the end of next FY. */
export function generateOnboardingEvents(engine: CalendarEngine, values: CalendarInputs, clientId: string, today: DateString): CalendarEvent[] {
  return generateEvents(calendarProfileFor(values, clientId), engine.rules, engine.overrides, { today, params: engine.params });
}

export function toPreviewEvent(e: CalendarEvent): PreviewEvent {
  return {
    dedupeKey: e.dedupeKey,
    title: e.title,
    formCode: e.formCode,
    filingPeriod: e.filingPeriod,
    dueDate: e.dueDate,
    sourceRef: e.sourceRef,
    overrideRef: e.overrideRef,
    originalDueDate: e.originalDueDate,
    provisional: e.provisional,
    fallsOnSunday: e.fallsOnSunday,
    serviceType: e.serviceType,
    notes: e.notes,
  };
}

/** Each service's next statutory due date (§7.3.2 step 3 "Next due date (auto from the statutory calendar)"). */
export function nextDueByService(events: readonly CalendarEvent[]): Partial<Record<ServiceType, DateString>> {
  const out: Partial<Record<ServiceType, DateString>> = {};
  for (const e of events) {
    if (!e.serviceType) continue;
    const cur = out[e.serviceType];
    if (!cur || compareDates(e.dueDate, cur) < 0) out[e.serviceType] = e.dueDate;
  }
  return out;
}

function money(v: string): string | null {
  if (!v.trim()) return null;
  const r = parseAmount(v);
  return r.ok ? paiseToDecimalString(r.paise) : null;
}

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/**
 * The onboard_client payload (0111) from validated wizard values. `events` are the engine's
 * events for `clientId` (empty when generation failed: the client is still created, with a warning).
 */
export function buildOnboardPayload(
  values: OnboardingData,
  ctx: {
    clientId: string;
    events: readonly CalendarEvent[];
    today: DateString;
    scale: ScaleContext;
    isPartner: boolean;
    acceptanceId: string | null;
    ip: string | null;
    userAgent: string | null;
  },
): Json {
  const decision = schemeDecisionFor(values, ctx.scale);
  const indication = taxAuditFor(values, ctx.scale);
  const reminderDays = Number(values.reminder_days) || 7;
  const nextDue = nextDueByService(ctx.events);
  const whatsapp = values.whatsapp_same_as_phone ? (isWhatsAppNumber(values.phone) ? values.phone : null) : blank(values.whatsapp);
  const address = [values.address, values.city, values.pincode].map((p) => p.trim()).filter(Boolean).join(", ");
  const team: Array<{ employee_id: string; team_role: string }> = [];
  if (values.engagement_partner_id) team.push({ employee_id: values.engagement_partner_id, team_role: "engagement_partner" });
  if (values.review_manager_id) team.push({ employee_id: values.review_manager_id, team_role: "review_manager" });
  for (const id of new Set(values.preparer_ids)) team.push({ employee_id: id, team_role: "preparer" });
  const auditKinds = values.services.some((s) => s.service_type === "audit") ? values.audit_kinds : [];

  const payload = {
    client: {
      id: ctx.clientId,
      client_code: values.client_code_auto ? null : values.client_code.toUpperCase(),
      display_name: values.display_name,
      legal_name: blank(values.legal_name),
      entity_type: values.entity_type || null,
      entity_type_other: values.entity_type === "other" ? blank(values.entity_type_other) : null,
      is_incorporated: values.is_incorporated,
      date_of_birth_or_incorporation: blank(values.date_of_birth_or_incorporation),
      pan: blank(values.pan)?.toUpperCase() ?? null,
      tan: blank(values.tan)?.toUpperCase() ?? null,
      gst_registration: values.gst_registration || "unknown",
      gstin: blank(values.gstin)?.toUpperCase() ?? null,
      state_code: blank(values.state_code),
      email: blank(values.email)?.toLowerCase() ?? null,
      phone: blank(values.phone),
      whatsapp,
      address: blank(values.address),
      city: blank(values.city),
      pincode: blank(values.pincode),
      notes: blank(values.notes),
      priority: values.priority,
      owner_employee_id: values.owner_employee_id,
      group_id: null,
      fy_end_month: Number(values.fy_end_month) || 3,
      annual_turnover: money(values.annual_turnover),
      turnover_fy: blank(values.turnover_fy),
      // Kept so every later generation plans the same advance-tax instalments as the preview (§6.7).
      income_nature: values.income_nature || null,
      // §6.6: keep a recorded choice only where it is honoured; otherwise derive from turnover.
      gst_scheme: values.gst_scheme_choice !== "auto" && decision.basis === "choice" ? values.gst_scheme_choice : null,
      tax_audit_applicable: indication ? (ctx.isPartner ? values.tax_audit_decision : "review") : null,
      tax_audit_note: indication ? blank(values.tax_audit_note) : null,
      reminder_days: reminderDays,
      notify_channels: values.notify_channels,
      source_lead_id: blank(values.source_lead_id),
      source_quotation_id: blank(values.source_quotation_id),
    },
    services: values.services.map((s) => ({
      service_type: s.service_type,
      custom_name: s.service_type === "other" ? blank(s.custom_name) : null,
      // §7.3.2 step 3: GST follows the scheme, whatever the browser sent.
      frequency: s.service_type === "gst" ? gstFrequencyLock(decision).frequency : s.frequency,
      next_due_date: blank(s.next_due_date) ?? nextDue[s.service_type] ?? null,
      agreed_fee: money(s.agreed_fee),
      billing_frequency: s.billing_frequency || null,
      sac_code: blank(s.sac_code),
      auto_invoice: s.auto_invoice,
      next_billing_date: blank(s.first_billing_date),
      source_quotation_item_id: blank(s.source_quotation_item_id),
    })),
    contact: {
      name: blank(values.contact_name) ?? values.display_name,
      role: blank(values.contact_role),
      email: blank(values.email)?.toLowerCase() ?? null,
      phone: blank(values.phone),
      whatsapp,
    },
    team,
    checklist: values.checklist.filter((i) => i.included).map((i) => ({ label: i.label, is_required: i.required, collected: i.collected })),
    events: ctx.events.map((e) => ({ ...toComplianceEventInsert(e), reminder_days: reminderDays })),
    tasks: initialTasks(values, ctx.today),
    kyc: {
      entity_category: kycCategoryFor(values.entity_type),
      pan: blank(values.pan)?.toUpperCase() ?? null,
      cin_llpin: null,
      registered_address: address || null,
      engagement_types: auditKinds.map((k) => AUDIT_KIND_ENGAGEMENT[k]),
    },
    acceptance_id: ctx.acceptanceId,
    duplicate_reason: blank(values.duplicate_reason),
    meta: { ip: ctx.ip, user_agent: ctx.userAgent },
  };
  return payload as unknown as Json;
}

/** The services in words for the welcome message (§10.4): "GST returns (quarterly)". */
export function servicesInWords(values: Pick<OnboardingData, "services">): string[] {
  const freq: Record<string, string> = { monthly: "monthly", quarterly: "quarterly", annual: "yearly", one_time: "one-time" };
  return values.services.map((s) => `${serviceName(s)} (${freq[s.frequency] ?? s.frequency})`);
}
