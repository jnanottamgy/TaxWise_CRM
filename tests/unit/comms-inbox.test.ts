import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ACTION_KIND_META,
  MarkNotificationsSchema,
  describeActionItem,
  groupActionItems,
  notificationActionResult,
  notificationGroupOf,
  notificationGroupsFor,
  notificationTypesInGroup,
  safeInboxLink,
  type ActionItem,
} from "@/lib/schemas/inbox";

/** The Inbox (§7.17): grouping, the words on each action item, notification groups and actions. */

function item(over: Partial<ActionItem>): ActionItem {
  return {
    kind: "review",
    entity_type: "task",
    entity_id: "00000000-0000-4000-8000-000000000001",
    client_id: null,
    client_name: "Sharma Traders",
    reference: "T-000123",
    title: "GSTR-3B for Sep 2026",
    person_name: "Ravi Kumar",
    amount: null,
    due_date: "2026-10-25",
    since: "2026-10-22T05:00:00Z",
    reason: null,
    note: null,
    item_count: null,
    link_url: "/work/00000000-0000-4000-8000-000000000001",
    ...over,
  };
}

const NOW = new Date("2026-10-23T06:30:00Z");

describe("groupActionItems", () => {
  it("orders groups as the Inbox lists them, newest first, capped per group", () => {
    const items = [
      item({ kind: "acceptance", entity_id: "a1", since: "2026-10-20T00:00:00Z" }),
      item({ kind: "invoice_approval", entity_type: "invoice", entity_id: "i1" }),
      item({ kind: "acceptance", entity_id: "a2", since: "2026-10-22T00:00:00Z" }),
      ...Array.from({ length: 7 }, (_, i) => item({ kind: "review", entity_id: `r${i}`, since: `2026-10-1${i}T00:00:00Z` })),
    ];
    const groups = groupActionItems(items, 5);
    expect(groups.map((g) => g.kind)).toEqual(["invoice_approval", "review", "acceptance"]);
    expect(groups[1].total).toBe(7);
    expect(groups[1].items).toHaveLength(5);
    expect(groups[1].items[0].entity_id).toBe("r6");
    expect(groups[2].items.map((i) => i.entity_id)).toEqual(["a2", "a1"]);
  });

  it("links every kind to the filtered list the dashboards use", () => {
    expect(ACTION_KIND_META.invoice_approval.viewAll).toBe("/invoices?status=awaiting_approval");
    expect(ACTION_KIND_META.quotation_approval.viewAll).toBe("/quotations?status=pending_approval");
    for (const k of ACTION_KINDS) expect(ACTION_KIND_META[k].viewAll.startsWith("/")).toBe(true);
  });
});

describe("describeActionItem", () => {
  it("an invoice approval shows the amount in Indian money and who raised it", () => {
    const v = describeActionItem(item({ kind: "invoice_approval", entity_type: "invoice", reference: null, title: "Sep 2026", amount: "118000.00", note: null }), NOW);
    expect(v.primary).toBe("Sharma Traders");
    expect(v.secondary).toBe("Invoice not yet numbered · Sep 2026 · raised by Ravi Kumar");
    expect(v.trailing).toEqual({ kind: "amount", text: "₹1,18,000.00" });
  });

  it("a declined task says who declined and why", () => {
    const v = describeActionItem(item({ kind: "declined", reason: "no_capacity", note: "Busy with audits" }), NOW);
    expect(v.secondary).toBe("T-000123 · Sharma Traders · declined by Ravi Kumar · No capacity this week: Busy with audits");
    expect(v.trailing).toEqual({ kind: "due", date: "2026-10-25" });
    expect(v.verb).toBe("Reassign");
  });

  it("client messages count the unread ones and say how long ago", () => {
    const v = describeActionItem(item({ kind: "client_message", item_count: 2, title: null, note: "Sent the\nbank   statement", since: "2026-10-23T04:30:00Z", due_date: null }), NOW);
    expect(v.secondary).toBe("2 unread messages · Sent the bank statement");
    expect(v.trailing).toEqual({ kind: "ago", text: "2 hours ago" });
  });

  it("leave shows the type, the days and the start", () => {
    const v = describeActionItem(item({ kind: "leave_approval", title: "casual", item_count: 1, reason: null, note: "Family function", due_date: "2026-11-02", client_name: null }), NOW);
    expect(v.primary).toBe("Ravi Kumar");
    expect(v.secondary).toBe("Casual leave · 1 day · Family function");
    expect(v.trailing).toEqual({ kind: "date", text: "from 02 Nov 2026" });
    expect(describeActionItem(item({ kind: "leave_approval", title: "sick", reason: "half_day", item_count: 1 }), NOW).secondary).toBe("Sick leave · Half day");
  });

  it("a data request names its type", () => {
    const v = describeActionItem(item({ kind: "data_request", reference: "erasure", title: "Asha Rao", reason: "open", since: "2026-10-20T06:00:00Z", due_date: "2026-11-19" }), NOW);
    expect(v.primary).toBe("Asha Rao");
    expect(v.secondary).toBe("Erasure request · received 20 Oct 2026");
  });
});

describe("notification groups and actions", () => {
  it("groups types as Profile → Notifications does, and keeps Money from Employees", () => {
    expect(notificationGroupOf("task_assigned")).toBe("work");
    expect(notificationGroupOf("invoice_overdue")).toBe("money");
    expect(notificationGroupOf("something_new")).toBe("general");
    expect(notificationTypesInGroup("team")).toContain("leave_requested");
    expect(notificationGroupsFor("employee")).not.toContain("money");
    expect(notificationGroupsFor("partner")).toContain("money");
  });

  it("says what a change did", () => {
    expect(notificationActionResult("read", 3)).toBe("3 notifications marked read.");
    expect(notificationActionResult("archived", 1)).toBe("1 notification archived.");
    expect(notificationActionResult("unread", 0)).toBe("Already unread.");
    expect(notificationActionResult("unarchived", 2)).toBe("2 notifications moved back to the inbox.");
  });

  it("takes 1–500 ids and a known action", () => {
    expect(MarkNotificationsSchema.safeParse({ ids: [], action: "read" }).success).toBe(false);
    expect(MarkNotificationsSchema.safeParse({ ids: ["not-a-uuid"], action: "read" }).success).toBe(false);
    expect(MarkNotificationsSchema.safeParse({ ids: ["00000000-0000-4000-8000-000000000001"], action: "star" }).success).toBe(false);
    expect(MarkNotificationsSchema.safeParse({ ids: ["00000000-0000-4000-8000-000000000001"], action: "archived" }).success).toBe(true);
  });

  it("only follows in-app links", () => {
    expect(safeInboxLink("/work/123")).toBe("/work/123");
    expect(safeInboxLink("//evil.example")).toBe("/inbox");
    expect(safeInboxLink("https://evil.example")).toBe("/inbox");
    expect(safeInboxLink(null)).toBe("/inbox");
  });
});
