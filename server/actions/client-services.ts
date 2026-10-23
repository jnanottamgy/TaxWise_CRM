"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { SERVICE_FREQUENCY_LABELS, type ServiceFrequency } from "@/lib/domain/enums";
import { todayIST } from "@/lib/domain/fy";
import { formatMoney, formatDate } from "@/lib/format";
import {
  AddServiceSchema,
  EndServiceSchema,
  RepriceServiceSchema,
  ResumeServiceSchema,
  UpdateServiceSchema,
  billingCycle,
  perCycleLabel,
  serviceName,
} from "@/lib/schemas/client-services";
import { asNumeric } from "@/components/client360/logic/master-data";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity } from "@/server/activity";
import { generateDeadlinesForClient } from "@/server/actions/compliance";

/**
 * Services & fees (§7.3.3 tab 3; §5.3 client_services), Partner/Manager only (RLS 0033: Employees
 * can't read or write the table at all):
 *
 *   addClientService      a new engagement (or an ended one resumed with new terms), optionally
 *                         with its agreed fee and fee_agreed_at;
 *   updateClientService   frequency, next due, billing frequency, SAC, auto-invoice, next billing date;
 *   repriceClientService  a new agreed fee, recording fee_agreed_at (the 0017 trigger writes the fee
 *                         history row);
 *   endClientService      stops it (and its automatic invoices), with a reason;
 *   resumeClientService   makes an ended service active again.
 *
 * Timeline entries that name a fee use money-side event types (fee_agreed, fee_changed,
 * fee_terms_changed), which Employees never read (0043); service events carry no amounts. Adding,
 * ending or resuming a service, or changing its frequency, regenerates the client's deadlines after
 * the save (idempotent, §6.7; ending one cancels its untouched future deadlines); a failure there is
 * a warning, never an error (§0.1 rule 5).
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This service was changed by someone else. Reload to see their changes.";
const DEADLINES_WARNING = "Compliance dates couldn't be regenerated. Use 'Generate deadlines' on the Compliance tab.";

/** fee_agreed_at for a chosen day: now when it is today, otherwise the start of that day in IST. */
function feeAgreedAt(date: string | null, today: string): string {
  if (!date || date === today) return new Date().toISOString();
  return new Date(`${date}T00:00:00+05:30`).toISOString();
}

async function clientOf(ctx: ActionContext, clientId: string): Promise<{ id: string; display_name: string } | null> {
  const { data, error } = await ctx.supabase.from("clients").select("id, display_name, deleted_at").eq("id", clientId).maybeSingle();
  throwIfDbError(error);
  return data && !data.deleted_at ? { id: data.id, display_name: data.display_name } : null;
}

async function loadService(ctx: ActionContext, id: string, clientId: string) {
  const { data, error } = await ctx.supabase
    .from("client_services")
    .select("id, client_id, service_type, custom_name, frequency, billing_frequency, agreed_fee, is_active, auto_invoice, next_billing_date, next_due_date, sac_code, updated_at")
    .eq("id", id)
    .maybeSingle();
  throwIfDbError(error);
  return data && data.client_id === clientId ? data : null;
}

function regenerateDeadlines(ctx: ActionContext, clientId: string) {
  ctx.after(
    "Regenerate the client's deadlines",
    async () => {
      const r = await generateDeadlinesForClient({ clientId });
      if (!r.ok) throw new Error(r.error);
    },
    DEADLINES_WARNING,
  );
}

function feeLine(fee: string | number | null, cycle: ServiceFrequency): string {
  return fee === null ? "no fee agreed" : `${formatMoney(fee)} ${perCycleLabel(cycle)}`;
}

export const addClientService = defineAction(
  { name: "client_services.add", schema: AddServiceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; resumed: boolean }>> => {
    const client = await clientOf(ctx, input.clientId);
    if (!client) return fail("That client isn't in the client list any more. It may be in the recycle bin.", { code: "not_found" });
    const today = todayIST();

    let existingQuery = ctx.supabase.from("client_services").select("id, is_active, updated_at").eq("client_id", client.id).eq("service_type", input.serviceType);
    existingQuery = input.customName ? existingQuery.eq("custom_name", input.customName) : existingQuery.is("custom_name", null);
    const { data: existing, error: existingError } = await existingQuery.maybeSingle();
    throwIfDbError(existingError);
    const name = serviceName(input.serviceType, input.customName);
    if (existing?.is_active) {
      return fail(`${client.display_name} already has ${name}. Change its terms or re-price it instead.`, { code: "conflict", fieldErrors: { serviceType: ["This service is already active for the client."] } });
    }

    const terms = {
      frequency: input.frequency,
      next_due_date: input.nextDueDate,
      billing_frequency: input.billingFrequency,
      sac_code: input.sacCode,
      auto_invoice: input.autoInvoice,
      next_billing_date: input.nextBillingDate,
      agreed_fee: asNumeric(input.agreedFee),
      fee_agreed_at: input.agreedFee !== null ? feeAgreedAt(input.feeAgreedOn, today) : null,
      is_active: true,
    };

    let id: string;
    if (existing) {
      const { data, error } = await ctx.supabase.from("client_services").update(terms).eq("id", existing.id).eq("updated_at", existing.updated_at).select("id");
      throwIfDbError(error);
      if (!data || data.length === 0) return fail(STALE, { code: "conflict" });
      id = existing.id;
    } else {
      const { data, error } = await ctx.supabase
        .from("client_services")
        .insert({ client_id: client.id, service_type: input.serviceType, custom_name: input.customName, ...terms })
        .select("id")
        .single();
      throwIfDbError(error, { uniqueField: "serviceType", uniqueMessage: "This service is already set up for the client." });
      id = (data as { id: string }).id;
    }

    const cycle = billingCycle(input.frequency, input.billingFrequency);
    await ctx.audit({
      event: existing ? "data_update" : "data_create",
      resourceType: "client_service",
      resourceId: id,
      details: { client_id: client.id, service_type: input.serviceType, frequency: input.frequency, agreed_fee: input.agreedFee, auto_invoice: input.autoInvoice, resumed: !!existing },
    });
    ctx.after("Add the service to the client's timeline", () =>
      addTimelineEvent({
        clientId: client.id,
        eventType: existing ? "service_resumed" : "service_added",
        title: `${existing ? "Service resumed" : "Service added"}: ${name} (${SERVICE_FREQUENCY_LABELS[input.frequency].toLowerCase()})`,
        metadata: { service_id: id, service_type: input.serviceType },
      }),
    );
    if (input.agreedFee !== null) {
      ctx.after("Record the agreed fee", () =>
        addTimelineEvent({
          clientId: client.id,
          eventType: "fee_agreed",
          title: `Fee agreed for ${name}: ${feeLine(input.agreedFee, cycle)}`,
          metadata: { service_id: id, agreed_fee: input.agreedFee, billing_frequency: cycle },
        }),
      );
    }
    regenerateDeadlines(ctx, client.id);
    return ok({ id, resumed: !!existing });
  },
);

export const updateClientService = defineAction(
  { name: "client_services.update", schema: UpdateServiceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const before = await loadService(ctx, input.id, input.clientId);
    if (!before) return fail("That service no longer exists. Reload to see the current services.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    if (!before.is_active) return fail("This service has ended. Resume it before changing its terms.", { code: "blocked" });
    if (input.autoInvoice && before.agreed_fee === null) {
      return fail("Agree a fee first: automatic invoices bill the agreed fee.", { code: "validation", fieldErrors: { autoInvoice: ["Re-price the service to set its fee first."] } });
    }

    const { data, error } = await ctx.supabase
      .from("client_services")
      .update({
        frequency: input.frequency,
        next_due_date: input.nextDueDate,
        billing_frequency: input.billingFrequency,
        sac_code: input.sacCode,
        auto_invoice: input.autoInvoice,
        next_billing_date: input.nextBillingDate,
      })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!saved) return fail(STALE, { code: "conflict" });

    const name = serviceName(before.service_type, before.custom_name);
    const changed: string[] = [];
    if (before.frequency !== input.frequency) changed.push(`frequency ${SERVICE_FREQUENCY_LABELS[input.frequency].toLowerCase()}`);
    if ((before.next_due_date ?? null) !== input.nextDueDate) changed.push(input.nextDueDate ? `next due ${formatDate(input.nextDueDate)}` : "next due cleared");
    if ((before.sac_code ?? null) !== input.sacCode) changed.push(input.sacCode ? `SAC ${input.sacCode}` : "SAC from the firm's map");
    const billingChanged =
      (before.billing_frequency ?? null) !== input.billingFrequency || before.auto_invoice !== input.autoInvoice || (before.next_billing_date ?? null) !== input.nextBillingDate;

    await ctx.audit({
      event: "data_update",
      resourceType: "client_service",
      resourceId: input.id,
      details: {
        client_id: input.clientId,
        frequency: input.frequency,
        billing_frequency: input.billingFrequency,
        auto_invoice: input.autoInvoice,
        next_billing_date: input.nextBillingDate,
        sac_code: input.sacCode,
      },
    });
    if (changed.length > 0) {
      ctx.after("Add the change to the client's timeline", () =>
        addTimelineEvent({ clientId: input.clientId, eventType: "service_updated", title: `${name}: ${changed.join(", ")}`, metadata: { service_id: input.id } }),
      );
    }
    if (billingChanged) {
      // Billing terms are money-side (§4.6: billing_frequency, auto_invoice, next_billing_date).
      const cycle = billingCycle(input.frequency, input.billingFrequency);
      const parts = [
        `billed ${perCycleLabel(cycle)}`,
        input.autoInvoice ? `automatic invoices from ${formatDate(input.nextBillingDate)}` : "automatic invoices off",
      ];
      ctx.after("Record the billing change", () =>
        addTimelineEvent({ clientId: input.clientId, eventType: "fee_terms_changed", title: `Billing for ${name}: ${parts.join(", ")}`, metadata: { service_id: input.id } }),
      );
    }
    if (before.frequency !== input.frequency) regenerateDeadlines(ctx, input.clientId);
    return ok({ id: saved.id, updatedAt: saved.updated_at });
  },
);

export const repriceClientService = defineAction(
  { name: "client_services.reprice", schema: RepriceServiceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    const before = await loadService(ctx, input.id, input.clientId);
    if (!before) return fail("That service no longer exists. Reload to see the current services.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    if (!before.is_active) return fail("This service has ended. Resume it before re-pricing.", { code: "blocked" });
    const today = todayIST();
    const agreedOn = input.feeAgreedOn as string;
    if (agreedOn > today) return fail("The date the fee was agreed can't be in the future.", { code: "validation", fieldErrors: { feeAgreedOn: ["Choose today or an earlier date."] } });

    const { data, error } = await ctx.supabase
      .from("client_services")
      .update({ agreed_fee: asNumeric(input.agreedFee), fee_agreed_at: feeAgreedAt(agreedOn, today) })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    throwIfDbError(error);
    const saved = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!saved) return fail(STALE, { code: "conflict" });

    const name = serviceName(before.service_type, before.custom_name);
    const cycle = billingCycle(before.frequency, before.billing_frequency);
    const from = before.agreed_fee === null ? null : formatMoney(before.agreed_fee);
    const to = formatMoney(input.agreedFee);
    await ctx.audit({
      event: "data_update",
      resourceType: "client_service",
      resourceId: input.id,
      action: "client_services.reprice",
      details: { client_id: input.clientId, agreed_fee: { from: before.agreed_fee, to: input.agreedFee }, fee_agreed_on: agreedOn, note: input.note },
    });
    ctx.after("Record the new fee on the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "fee_changed",
        title: from ? `Fee for ${name} re-priced from ${from} to ${to} ${perCycleLabel(cycle)}` : `Fee agreed for ${name}: ${to} ${perCycleLabel(cycle)}`,
        description: input.note,
        metadata: { service_id: input.id, agreed_fee: input.agreedFee, previous_fee: before.agreed_fee, agreed_on: agreedOn },
      }),
    );
    ctx.after("Record the new fee in the service's history", () =>
      logActivity({
        entityType: "client_service",
        entityId: input.id,
        action: "fee_changed",
        description: from ? `Re-priced from ${from} to ${to}` : `Fee agreed at ${to}`,
        metadata: { agreed_fee: input.agreedFee, previous_fee: before.agreed_fee },
      }),
    );
    return ok({ id: saved.id, updatedAt: saved.updated_at });
  },
);

export const endClientService = defineAction(
  { name: "client_services.end", schema: EndServiceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const before = await loadService(ctx, input.id, input.clientId);
    if (!before) return fail("That service no longer exists. Reload to see the current services.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    if (!before.is_active) return ok({ id: input.id });

    const { data, error } = await ctx.supabase
      .from("client_services")
      .update({ is_active: false, auto_invoice: false })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail(STALE, { code: "conflict" });

    const name = serviceName(before.service_type, before.custom_name);
    await ctx.audit({ event: "data_update", resourceType: "client_service", resourceId: input.id, action: "client_services.end", details: { client_id: input.clientId, ended_on: input.endedOn, reason: input.reason } });
    ctx.after("Add the change to the client's timeline", () =>
      addTimelineEvent({
        clientId: input.clientId,
        eventType: "service_ended",
        title: `Service ended: ${name}, from ${formatDate(input.endedOn)}`,
        description: input.reason,
        metadata: { service_id: input.id, ended_on: input.endedOn },
      }),
    );
    // Cancels the ended service's untouched future deadlines (with a history line), §7.7.
    regenerateDeadlines(ctx, input.clientId);
    return ok({ id: input.id });
  },
);

export const resumeClientService = defineAction(
  { name: "client_services.resume", schema: ResumeServiceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const before = await loadService(ctx, input.id, input.clientId);
    if (!before) return fail("That service no longer exists. Reload to see the current services.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    if (before.is_active) return ok({ id: input.id });

    const { data, error } = await ctx.supabase.from("client_services").update({ is_active: true }).eq("id", input.id).eq("updated_at", input.updatedAt).select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail(STALE, { code: "conflict" });

    const name = serviceName(before.service_type, before.custom_name);
    await ctx.audit({ event: "data_update", resourceType: "client_service", resourceId: input.id, action: "client_services.resume", details: { client_id: input.clientId } });
    ctx.after("Add the change to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "service_resumed", title: `Service resumed: ${name}`, metadata: { service_id: input.id } }),
    );
    regenerateDeadlines(ctx, input.clientId);
    return ok({ id: input.id });
  },
);
