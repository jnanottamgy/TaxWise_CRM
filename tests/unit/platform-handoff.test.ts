import { describe, expect, it } from "vitest";
import {
  CallNoteSchema,
  EMAIL_NOT_SET_UP_MESSAGE,
  HandoffSchema,
  deliveryFailedMessage,
  emailOutcomeNotice,
  messageStatusInfo,
} from "@/lib/handoff";

const CLIENT = "6f1c1d0e-8a8b-4c7d-9e0f-1a2b3c4d5e6f";
const CONTACT = "0b7d3c1a-2f4e-4d6a-8b9c-0d1e2f3a4b5c";

describe("hand-off schema (§7.13.2, §7.13.3)", () => {
  it("accepts a WhatsApp hand-off and normalises empty optionals to null", () => {
    const r = HandoffSchema.safeParse({ clientId: CLIENT, contactId: "", channel: "whatsapp_handoff", recipient: "919845012345", body: "Hi Rakesh", subject: "", templateId: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ contactId: null, subject: null, templateId: null, related: null });
  });

  it("keeps the related record", () => {
    const r = HandoffSchema.parse({ clientId: CLIENT, contactId: CONTACT, channel: "gmail_handoff", recipient: "a@b.com", subject: "Invoice TW/26-27/0042", body: "Please find…", related: { type: "invoice", id: CLIENT } });
    expect(r.related).toEqual({ type: "invoice", id: CLIENT });
  });

  it("refuses other channels, an empty message and bad record types", () => {
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "email", recipient: "a@b.com", body: "x" }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "gmail_handoff", recipient: "a@b.com", body: "   " }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: CLIENT, channel: "gmail_handoff", recipient: "a@b.com", body: "x", related: { type: "Invoice; drop", id: CLIENT } }).success).toBe(false);
    expect(HandoffSchema.safeParse({ clientId: "nope", channel: "gmail_handoff", recipient: "a@b.com", body: "x" }).success).toBe(false);
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

  it("calls and notes are logged; emails follow Resend; portal messages are read", () => {
    expect(messageStatusInfo("call_log", "sent").label).toBe("Logged");
    expect(messageStatusInfo("internal_note", "sent").label).toBe("Logged");
    expect(messageStatusInfo("email", "delivered")).toMatchObject({ label: "Delivered", tone: "success" });
    expect(messageStatusInfo("email", "read").label).toBe("Opened");
    expect(messageStatusInfo("portal", "read").label).toBe("Read");
    expect(messageStatusInfo("email", "failed")).toMatchObject({ label: "Failed", tone: "danger" });
  });

  it("says what to do when email can't be used (§7.13.3, §7.13.5)", () => {
    expect(EMAIL_NOT_SET_UP_MESSAGE).toBe("Email isn't set up yet. Use WhatsApp or Gmail, or finish email setup.");
    expect(deliveryFailedMessage("Sharma Traders")).toBe(
      "Delivery failed, so Sharma Traders hasn't received this. Send it from your own mailbox instead; the note and link are filled in.",
    );
    expect(emailOutcomeNotice({ status: "sent" }, "Sharma Traders")).toEqual({ tone: "success", message: "Emailed to Sharma Traders.", detail: null, offerHandoff: false });
    expect(emailOutcomeNotice({ status: "not_configured", error: "x" }, "Sharma Traders")).toMatchObject({ tone: "warning", offerHandoff: true, message: EMAIL_NOT_SET_UP_MESSAGE });
    expect(emailOutcomeNotice({ status: "failed", error: "Bounced" }, "Sharma Traders")).toMatchObject({ tone: "danger", offerHandoff: true, detail: "Bounced" });
  });
});
