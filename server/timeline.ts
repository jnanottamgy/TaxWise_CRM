import "server-only";

import type { Json } from "@/lib/database.types";
import { createAdminClient } from "@/server/admin";
import { scrubMoneyMetadata, sessionActor } from "@/server/activity";
import { isMoneySideKind } from "@/lib/handoff";
import { log } from "@/lib/log";

/**
 * The client's story (§5.11 client_timeline_events, Client 360 → Timeline, §7.3.3).
 *
 *   ctx.after("Add to the client's timeline", () => addTimelineEvent({
 *     clientId, eventType: "task_created", title: "Task created: GSTR-3B for September 2026",
 *   }));
 *
 * Runs after the main write and never throws (§0.1 rule 5): a failure is logged and the save stands.
 * Under a signed-in user it writes through their session (RLS: an Employee writes only non-money
 * events for clients they can see; a portal user only their own client's); in a job, a webhook or
 * the public quotation page it writes as the system. `performedBy` defaults to the signed-in user.
 *
 * Money stays on the money side (§4.1, 0043): events about leads, quotations, invoices, payments,
 * receipts, credit notes, engagement letters, fees and TDS credits must use an event type that
 * starts with that word (`invoice_sent`, `payment_received`, `fee_changed`), which Employees never
 * see. For any other event type, money-named metadata keys are dropped, and titles must not carry
 * fee amounts.
 */

export interface TimelineEventInput {
  clientId?: string | null;
  leadId?: string | null;
  /** lead_created, quotation_sent, client_onboarded, document_uploaded, task_created, compliance_filed, invoice_sent, payment_received, message_sent, note_added, employee_assigned … */
  eventType: string;
  title: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  /** profiles.id; defaults to the signed-in user. */
  performedBy?: string | null;
}

/** Adds one event to a client's (or a lead's) timeline. Never throws. */
export async function addTimelineEvent(input: TimelineEventInput): Promise<void> {
  const actor = await sessionActor();
  try {
    if (!input.clientId && !input.leadId) {
      log("warn", "timeline event without a client or lead skipped", { source: "server:timeline", eventType: input.eventType });
      return;
    }
    const eventType = input.eventType.trim().slice(0, 60);
    const moneySide = isMoneySideKind(eventType) || (Boolean(input.leadId) && !input.clientId);
    const { metadata, dropped } = scrubMoneyMetadata(input.metadata, moneySide);
    if (dropped.length) {
      log("warn", "money keys dropped from timeline metadata", { source: "server:timeline", eventType, dropped, userId: actor?.userId });
    }
    const writer = actor ? actor.supabase : createAdminClient();
    const { error } = await writer.from("client_timeline_events").insert({
      client_id: input.clientId ?? null,
      lead_id: input.leadId ?? null,
      event_type: eventType,
      title: input.title.trim().slice(0, 300),
      description: input.description ? input.description.trim().slice(0, 2000) : null,
      metadata: (metadata ?? null) as Json,
      performed_by: input.performedBy ?? actor?.userId ?? null,
    });
    if (error) throw error;
  } catch (err) {
    log("error", "timeline write failed", {
      source: "server:timeline",
      userId: actor?.userId,
      role: actor?.role,
      eventType: input.eventType,
      clientId: input.clientId ?? null,
      err,
    });
  }
}
