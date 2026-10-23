import { describe, expect, it } from "vitest";
import {
  BulkSourceSchema,
  buildQueueDraft,
  complianceWindowEnd,
  planQueueStep,
  queueLabel,
  queueValues,
  sortQueue,
  type QueueContext,
  type QueueFacts,
  type QueueStep,
} from "@/lib/schemas/inbox";
import { currentItem, initQueue, isQueueDone, nextOpenIndex, queueProgressLabel, queueReducer, queueTally } from "@/components/bulk-queue/queue-state";

/** Bulk WhatsApp reminders (§7.13.2): the drafts and the step-through state. */

const ctx: QueueContext = { firmName: "TaxWise Consultants", firmPhone: "+91 80 4123 4567", senderName: "Ravi Kumar", today: "2026-10-23", countryCode: "91", signature: { format: "– {first_name}" } };

const facts: Omit<QueueFacts, "contactName" | "clientName" | "clientCode"> = {
  kind: "data_awaited",
  serviceType: "gst",
  complianceType: null,
  formLabel: null,
  period: "Sep 2026",
  dueDate: "2026-10-20",
  taskTitle: "GSTR-3B for Sep 2026",
  priority: "High",
  missing: ["Sales register", "Purchase register"],
  portalLink: "https://crm.twchartered.com/portal",
};

const client = { id: "c1", name: "Sharma Traders", code: "TW-C-0012", phone: null, whatsapp: null, status: "active" };
const contacts = [
  { id: "k1", name: "Rakesh Sharma", phone: "98450 12345", whatsapp: null, isPrimary: true, handles: [] },
  { id: "k2", name: "Meena Iyer", phone: null, whatsapp: "+91 99000 11122", isPrimary: false, handles: ["gst"] },
];

describe("drafts", () => {
  it("fills the spec's default Data awaited draft for the contact who handles the service, and signs it", () => {
    const planned = planQueueStep({ key: "task:t1", facts, client, contacts, ctx, template: null, related: { type: "task", id: "t1" } });
    expect("step" in planned).toBe(true);
    if (!("step" in planned)) return;
    expect(planned.step.contactId).toBe("k2");
    expect(planned.step.number).toBe("919900011122");
    expect(planned.step.draft).toBe(
      "Hi Meena, for your GST returns for Sep 2026 we still need:\n• Sales register\n• Purchase register\n\nYou can upload them here: https://crm.twchartered.com/portal\n\n– Ravi",
    );
    expect(planned.step.label).toBe("GSTR-3B for Sep 2026 · Sep 2026 · due 20 Oct 2026");
    expect(planned.step.related).toEqual({ type: "task", id: "t1" });
  });

  it("uses the chosen template, and tidies 'Hi ,' when there is no contact", () => {
    const f: QueueFacts = { ...facts, kind: "compliance_due", complianceType: "gstr_3b", formLabel: "GSTR-3B", missing: [], clientName: "Sharma Traders", clientCode: "TW-C-0012", contactName: null, dueDate: "2026-10-28" };
    expect(buildQueueDraft(f, { ...ctx, signature: null }, null)).toBe(
      "Hi, GSTR-3B for Sep 2026 is due on 28 Oct 2026. If we still need anything from you, please share it soon so we can file on time. You can upload documents here: https://crm.twchartered.com/portal",
    );
    expect(buildQueueDraft(f, { ...ctx, signature: null }, { body: "{{compliance_type}} due in {{days_until_due}} days for {{client_name}} ({{client_code}})" })).toBe("GSTR-3B due in 5 days for Sharma Traders (TW-C-0012)");
  });

  it("works out days overdue and lists the work when nothing specific is missing", () => {
    const v = queueValues({ ...facts, missing: [], clientName: "X", clientCode: "C", contactName: "CA Vinay H Karlagere" }, ctx);
    expect(v.days_overdue).toBe("3");
    expect(v.days_until_due).toBe("");
    expect(v.contact_name).toBe("Vinay");
    expect(v.missing_items).toBe("• The data and documents for GSTR-3B for Sep 2026");
  });

  it("falls back to the client's own number, and keeps a step with no number so it can be skipped", () => {
    const withOwn = planQueueStep({ key: "k", facts, client: { ...client, whatsapp: "12345", phone: "9845012345" }, contacts: [], ctx, template: null, related: null });
    expect("step" in withOwn && withOwn.step.number).toBe("919845012345");
    const none = planQueueStep({ key: "k", facts, client, contacts: [{ ...contacts[0], phone: "12345" }], ctx, template: null, related: null });
    expect("step" in none && none.step.number).toBeNull();
  });

  it("leaves out clients on hold or inactive (§7.3.4)", () => {
    const held = planQueueStep({ key: "k", facts, client: { ...client, status: "on_hold" }, contacts, ctx, template: null, related: null });
    expect(held).toEqual({ skip: { clientName: "Sharma Traders", label: queueLabel({ ...facts, clientName: "Sharma Traders", clientCode: "TW-C-0012", contactName: null }), reason: "Client is on hold: reminders are paused." } });
  });

  it("sorts by client, then by what it's about", () => {
    const s = (clientName: string, label: string) => ({ clientName, label }) as QueueStep;
    expect(sortQueue([s("Zeta", "b"), s("Alpha", "b"), s("Alpha", "a")]).map((x) => `${x.clientName}/${x.label}`)).toEqual(["Alpha/a", "Alpha/b", "Zeta/b"]);
  });

  it("caps the compliance window at 60 days and accepts only known sources", () => {
    expect(complianceWindowEnd("2026-10-23", 7)).toBe("2026-10-30");
    expect(complianceWindowEnd("2026-10-23", 400)).toBe("2026-12-22");
    expect(BulkSourceSchema.safeParse({ kind: "compliance_due", withinDays: 61 }).success).toBe(false);
    expect(BulkSourceSchema.safeParse({ kind: "tasks", ids: [] }).success).toBe(false);
    expect(BulkSourceSchema.safeParse({ kind: "payments" }).success).toBe(false);
    expect(BulkSourceSchema.safeParse({ kind: "data_awaited" }).success).toBe(true);
  });
});

describe("the queue's state", () => {
  const step = (key: string, number: string | null = "919845012345"): QueueStep => ({ key, clientId: key, clientName: key, contactId: null, contactName: null, number, label: "x", draft: `Draft ${key}`, templateId: null, related: null })

  it("Open WhatsApp → mark handed off → next", () => {
    let s = initQueue([step("a"), step("b")])
    s = queueReducer(s, { type: "opened" })
    expect(currentItem(s)?.status).toBe("opened")
    s = queueReducer(s, { type: "logging" })
    s = queueReducer(s, { type: "logged" })
    expect(s.index).toBe(1)
    expect(s.items[0].status).toBe("handed_off")
    expect(queueProgressLabel(s)).toBe("2 of 2 · 1 handed off")
  })

  it("can't mark handed off before WhatsApp was opened, nor open a step with no number", () => {
    let s = initQueue([step("a", null), step("b")])
    s = queueReducer(s, { type: "opened" })
    expect(currentItem(s)?.status).toBe("pending")
    expect(queueReducer(s, { type: "logging" })).toBe(s)
    s = queueReducer(s, { type: "skip" })
    expect(s.items[0].status).toBe("skipped")
    expect(s.index).toBe(1)
  })

  it("a failed log stays on the step to retry, and the queue comes back to it at the end", () => {
    let s = initQueue([step("a"), step("b")])
    s = queueReducer(queueReducer(queueReducer(s, { type: "opened" }), { type: "logging" }), { type: "log_failed", error: "offline" })
    expect(currentItem(s)).toMatchObject({ status: "failed", error: "offline" })
    s = queueReducer(s, { type: "skip" })
    expect(s.index).toBe(1)
    s = queueReducer(queueReducer(queueReducer(s, { type: "opened" }), { type: "logging" }), { type: "logged" })
    expect(isQueueDone(s)).toBe(true)
    expect(queueTally(s)).toMatchObject({ handedOff: 1, skipped: 1, failed: 0, remaining: 0 })
  })

  it("edits the draft until it is handed off, and goes back", () => {
    let s = initQueue([step("a"), step("b")])
    s = queueReducer(s, { type: "edit", draft: "Changed" })
    expect(s.items[0].draft).toBe("Changed")
    s = queueReducer(queueReducer(queueReducer(s, { type: "opened" }), { type: "logging" }), { type: "logged" })
    s = queueReducer(s, { type: "back" })
    expect(s.index).toBe(0)
    expect(queueReducer(s, { type: "edit", draft: "Again" }).items[0].draft).toBe("Changed")
    expect(queueReducer(s, { type: "goto", index: 9 })).toBe(s)
  })

  it("nextOpenIndex wraps to earlier steps still to do", () => {
    const s = initQueue([step("a"), step("b"), step("c")])
    const items = s.items.map((it, i) => (i === 2 ? { ...it, status: "handed_off" as const } : it))
    expect(nextOpenIndex(items, 2)).toBe(0)
    expect(nextOpenIndex(items.map((it) => ({ ...it, status: "skipped" as const })), 0)).toBe(3)
  })
})
