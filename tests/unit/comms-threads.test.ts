import { describe, expect, it } from "vitest";
import { PortalReplySchema, dayLabel, isCommChannelFilter, senderLabel, threadEntries, type ThreadMessage } from "@/lib/schemas/inbox";

/** Staff message threads (§7.13.1): how a client's history is laid out. */

let seq = 0;
function msg(over: Partial<ThreadMessage>): ThreadMessage {
  seq++;
  return {
    id: `m${String(seq).padStart(3, "0")}`,
    channel: "portal",
    direction: "outbound",
    status: "sent",
    subject: null,
    body: "Hello",
    recipient: null,
    at: "2026-10-22T05:00:00Z",
    created_at: "2026-10-22T05:00:00Z",
    sent_by: "me",
    sender_name: "Anita Rao",
    contact_name: null,
    template_name: null,
    related_entity_type: null,
    read_at: null,
    delivered_at: null,
    failed_at: null,
    error: null,
    attachments: [],
    ...over,
  };
}

describe("threadEntries", () => {
  it("orders oldest first with a divider per IST day", () => {
    const out = threadEntries(
      [
        msg({ id: "b", created_at: "2026-10-23T03:00:00Z" }),
        msg({ id: "a", created_at: "2026-10-21T19:00:00Z" }), // 22 Oct 00:30 IST
        msg({ id: "z", created_at: "2026-10-20T10:00:00Z" }),
      ],
      { newSince: null, me: "me", today: "2026-10-23" },
    );
    expect(out.map((e) => (e.kind === "message" ? e.message.id : e.kind === "day" ? e.label : "new"))).toEqual(["20 Oct 2026", "z", "Yesterday", "a", "Today", "b"]);
  });

  it("marks where you left off, before the first message someone else added", () => {
    const out = threadEntries(
      [
        msg({ id: "old", created_at: "2026-10-22T04:00:00Z", direction: "inbound", sent_by: "client" }),
        msg({ id: "mine", created_at: "2026-10-22T06:00:00Z" }),
        msg({ id: "theirs", created_at: "2026-10-22T07:00:00Z", direction: "inbound", sent_by: "client" }),
        msg({ id: "later", created_at: "2026-10-22T08:00:00Z", sent_by: "colleague" }),
      ],
      { newSince: "2026-10-22T05:00:00Z", me: "me", today: "2026-10-23" },
    );
    const ids = out.map((e) => (e.kind === "message" ? e.message.id : e.kind));
    expect(ids).toEqual(["day", "old", "mine", "new", "theirs", "later"]);
    expect(out.find((e) => e.kind === "message" && e.message.id === "mine")).toMatchObject({ mine: true });
  });

  it("marks nothing on a first visit", () => {
    const out = threadEntries([msg({ direction: "inbound", sent_by: "client" })], { newSince: null, me: "me", today: "2026-10-23" });
    expect(out.some((e) => e.kind === "new")).toBe(false);
  });
});

describe("senderLabel and dayLabel", () => {
  it("names who a message is from", () => {
    expect(senderLabel({ direction: "inbound", channel: "portal", sender_name: null, contact_name: null }, "Sharma Traders")).toBe("Sharma Traders (portal)");
    expect(senderLabel({ direction: "inbound", channel: "call_log", sender_name: "Anita", contact_name: "Rakesh" }, "Sharma Traders")).toBe("Rakesh called");
    expect(senderLabel({ direction: "outbound", channel: "email", sender_name: "Anita Rao", contact_name: "Rakesh" }, "Sharma Traders")).toBe("Anita Rao");
    expect(senderLabel({ direction: "outbound", channel: "email", sender_name: null, contact_name: null }, "Sharma Traders")).toBe("The firm");
  });

  it("says Today and Yesterday, then the date", () => {
    expect(dayLabel("2026-10-23", "2026-10-23")).toBe("Today");
    expect(dayLabel("2026-10-22", "2026-10-23")).toBe("Yesterday");
    expect(dayLabel("2026-09-30", "2026-10-23")).toBe("30 Sep 2026");
  });
});

describe("PortalReplySchema and filters", () => {
  it("needs a client and a message, at most 5,000 characters", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(PortalReplySchema.safeParse({ clientId: id, body: "  " }).success).toBe(false);
    expect(PortalReplySchema.safeParse({ clientId: id, body: "x".repeat(5001) }).success).toBe(false);
    const ok = PortalReplySchema.safeParse({ clientId: id, body: " Received, thank you. ", templateId: "" });
    expect(ok.success && ok.data).toEqual({ clientId: id, body: "Received, thank you.", templateId: null });
  });

  it("knows its channel filters", () => {
    expect(isCommChannelFilter("calls")).toBe(true);
    expect(isCommChannelFilter("sms")).toBe(false);
    expect(isCommChannelFilter("toString")).toBe(false);
  });
});
