import { describe, expect, it } from "vitest";
import {
  CallNoteSchema,
  HANDOFF_CHANNELS,
  HandoffSchema,
  MESSAGE_CHANNEL_LABEL,
  handoffMoneyKind,
  isMoneySideKind,
  messageStatusInfo,
} from "@/lib/handoff";

const CLIENT = "6f1c1d0e-8a8b-4c7d-9e0f-1a2b3c4d5e6f";
const CONTACT = "0b7d3c1a-2f4e-4d6a-8b9c-0d1e2f3a4b5c";

describe("hand-off schema (§7.13.2)", () => {
  it("accepts a WhatsApp hand-off and normalises empty optionals to null", () => {
    const r = HandoffSchema.safeParse({ clientId: CLIENT, contactId: "", channel: "whatsapp_handoff", recipient: "919845012345", body: "Hi Rakesh", subject: "", templateId: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ contactId: null, subject: null, templateId: null, related: null });
  });

  it("keeps the related record", () => {
    const r = HandoffSchema.parse({ clientId: CLIENT, contactId: CONTACT, channel: "whatsapp_handoff", recipient: "919845012345", body: "Please find…", related: { type: "invoice", id: CLIENT } });
    expect(r.related).toEqual({ type: "invoice", id: CLIENT });
  });

  it("is WhatsApp only: email and Gmail are refused, as are an empty message and bad record types", () => {
    expect(HANDOFF_CHANNELS).toEqual(["whatsapp_handoff"]);
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "email", recipient: "a@b.com", body: "x" }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "gmail_handoff", recipient: "a@b.com", body: "x" }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "whatsapp_handoff", recipient: "919845012345", body: "   " }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "whatsapp_handoff", recipient: "919845012345", body: "x", related: { type: "Invoice; drop", id: CLIENT } }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: "nope", channel: "whatsapp_handoff", recipient: "919845012345", body: "x" }).success).toBe(false);
  });
});

describe("Log a call (§7.3.3 Communication)", () => {
  it("defaults to an outgoing call logged now", () => {
    const r = CallNoteSchema.parse({ clientId: CLIENT, body: "Asked for the September purchase invoices." });
    expect(r).toMatchObject({ kind: "call_out", occurredAt: null, subject: null, contactId: null });
  });

  it("asks for what was discussed and refuses a call in the future", () => {
    const empty = CallNoteSchema.safeParse({ clientId: CLIENT, body: "" });
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues[0].message).toBe("Write what was discussed.");
    const future = CallNoteSchema.safeParse({ clientId: CLIENT, body: "x", occurredAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.success).toBe(false);
    expect(CallNoteSchema.safeParse({ clientId: CLIENT, body: "x", occurredAt: "2026-10-22T10:15:00+05:30", kind: "meeting" }).success).toBe(true);
    expect(CallNoteSchema.safeParse({ clientId: CLIENT, body: "x", occurredAt: "yesterday" }).success).toBe(false);
  });
});

describe("what the app may claim (§7.13.1)", () => {
  it("a hand-off is only ever handed off, never delivered", () => {
    for (const status of ["handed_off", "sent", "delivered", "read"]) {
      expect(messageStatusInfo("whatsapp_handoff", status).label).toBe("Handed off");
      expect(messageStatusInfo("gmail_handoff", status).label).toBe("Handed off");
    }
    expect(messageStatusInfo("whatsapp_handoff", "sent").meaning).toMatch(/can't see whether it was sent or delivered/);
  });

  it("calls and notes are logged; portal messages are read", () => {
    expect(messageStatusInfo("call_log", "sent").label).toBe("Logged");
    expect(messageStatusInfo("internal_note", "sent").label).toBe("Logged");
    expect(messageStatusInfo("portal", "read").label).toBe("Read");
  });

  it("older emails and Gmail hand-offs in the history still read properly", () => {
    expect(MESSAGE_CHANNEL_LABEL.email).toBe("Email");
    expect(MESSAGE_CHANNEL_LABEL.gmail_handoff).toBe("Gmail");
    expect(messageStatusInfo("email", "delivered")).toMatchObject({ label: "Delivered", tone: "success" });
    expect(messageStatusInfo("email", "read").label).toBe("Opened");
    expect(messageStatusInfo("email", "failed")).toMatchObject({ label: "Failed", tone: "danger" });
    expect(messageStatusInfo("email", "failed").meaning).toMatch(/WhatsApp/);
  });
});

describe("handoffMoneyKind (§4.1: a hand-off about money stays on the money side)", () => {
  it("is the related record's type when that is money-side", () => {
    expect(handoffMoneyKind("invoice", null)).toBe("invoice");
    expect(handoffMoneyKind("quotation", "document_reminder")).toBe("quotation");
    expect(handoffMoneyKind("credit_note", null)).toBe("credit_note");
  });

  it("is money-side for a payment-reminder or quotation template even without a related record", () => {
    expect(handoffMoneyKind(null, "payment_reminder")).toBe("payment");
    expect(handoffMoneyKind("task", "payment_reminder")).toBe("payment");
    expect(handoffMoneyKind(undefined, "quotation")).toBe("quotation");
  });

  it("is null for everything else", () => {
    expect(handoffMoneyKind(null, null)).toBeNull();
    expect(handoffMoneyKind("task", "document_reminder")).toBeNull();
    expect(handoffMoneyKind("document_request", "general")).toBeNull();
  });

  it("gives timeline event types Employees never read (money_side_kind, 0043)", () => {
    for (const [related, template] of [["invoice", null], [null, "payment_reminder"], [null, "quotation"]] as const) {
      const kind = handoffMoneyKind(related, template);
      expect(kind).not.toBeNull();
      expect(isMoneySideKind(`${kind}_message_sent`)).toBe(true);
      expect(isMoneySideKind(`${kind}_note_added`)).toBe(true);
    }
    expect(isMoneySideKind("message_sent")).toBe(false);
  });
});
