import { describe, expect, it } from "vitest";
import {
  CONTACT_METHOD_MESSAGE,
  LeadFormSchema,
  MoveLeadSchema,
  analyticsPeriod,
  conversionRate,
  emptyLeadValues,
  isFollowUpDue,
  isLeadStale,
  leadMoveCheck,
  leadTitle,
  lostCategoryLabel,
  parseLeadView,
  servicesPhrase,
  stageMoveTitle,
} from "@/lib/schemas/leads";

/**
 * Leads (§7.5.1): the form's contact rule, stage moves (a reason for Lost; a converted lead stays
 * Won), the follow-up and 14-day rules the job and the board share, and the analytics period and
 * conversion rate (won ÷ closed).
 */

const ID = "4b0f5a8e-2c1d-4e3f-9a7b-6c5d4e3f2a1b";

describe("the lead form (§7.5.1)", () => {
  it("needs a name, a source and at least one way to reach them", () => {
    const none = LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma" }));
    expect(none.success).toBe(false);
    const issues = none.success ? [] : none.error.issues;
    expect(issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["email", "phone", "whatsapp"]));
    expect(issues[0].message).toBe(CONTACT_METHOD_MESSAGE);
    expect(LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma", phone: "98765 43210" })).success).toBe(true);
    expect(LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma", whatsapp: "+91 98765 43210" })).success).toBe(true);
  });

  it("checks the email and phone, and keeps Won and Lost off the form", () => {
    expect(LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma", email: "ravi@" })).success).toBe(false);
    expect(LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma", phone: "12345" })).success).toBe(false);
    expect(LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma", email: "ravi@sharmatraders.in", status: "won" as never })).success).toBe(false);
  });

  it("de-duplicates the services asked for", () => {
    const r = LeadFormSchema.safeParse(emptyLeadValues({ name: "Ravi Sharma", email: "ravi@sharmatraders.in", services_required: ["gst", "gst", "audit"] }));
    expect(r.success && r.data.services_required).toEqual(["gst", "audit"]);
  });
});

describe("stage moves (§7.5.1 board)", () => {
  it("asks for a reason when moving to Lost", () => {
    expect(leadMoveCheck({ status: "contacted", converted_client_id: null }, "lost")).toEqual({ ok: true, requiresReason: true });
    expect(leadMoveCheck({ status: "contacted", converted_client_id: null }, "proposal_sent")).toEqual({ ok: true, requiresReason: false });
    expect(MoveLeadSchema.safeParse({ id: ID, to: "lost", updatedAt: "x", lostCategory: "", lostReason: "" }).success).toBe(false);
    expect(MoveLeadSchema.safeParse({ id: ID, to: "lost", updatedAt: "x", lostCategory: "fees", lostReason: "Too costly for them" }).success).toBe(true);
    expect(MoveLeadSchema.safeParse({ id: ID, to: "negotiation", updatedAt: "x" }).success).toBe(true);
  });

  it("keeps a converted lead at Won and refuses a no-op move", () => {
    expect(leadMoveCheck({ status: "won", converted_client_id: "c1" }, "negotiation")).toEqual({ ok: false, error: "This lead has become a client, so it stays Won." });
    expect(leadMoveCheck({ status: "contacted", converted_client_id: null }, "contacted").ok).toBe(false);
  });

  it("words the timeline entry and the loss category", () => {
    expect(stageMoveTitle("Contacted", "Proposal sent")).toBe("Stage moved from Contacted to Proposal sent");
    expect(lostCategoryLabel("competitor")).toMatch(/\S/);
    expect(lostCategoryLabel(null)).toMatch(/\S/);
  });
});

describe("follow-ups and untouched leads (§7.5.1 automation)", () => {
  const now = new Date("2026-10-23T09:00:00Z");

  it("is due once its time has come, unless the lead is closed", () => {
    expect(isFollowUpDue({ status: "contacted", next_follow_up_at: "2026-10-23T08:59:00Z" }, now)).toBe(true);
    expect(isFollowUpDue({ status: "contacted", next_follow_up_at: "2026-10-23T09:01:00Z" }, now)).toBe(false);
    expect(isFollowUpDue({ status: "won", next_follow_up_at: "2026-10-01T09:00:00Z" }, now)).toBe(false);
    expect(isFollowUpDue({ status: "contacted", next_follow_up_at: null }, now)).toBe(false);
  });

  it("is untouched after more than 14 days without activity", () => {
    expect(isLeadStale({ status: "new_lead", last_activity_at: "2026-10-08T08:59:00Z" }, now)).toBe(true);
    expect(isLeadStale({ status: "new_lead", last_activity_at: "2026-10-09T09:01:00Z" }, now)).toBe(false);
    expect(isLeadStale({ status: "lost", last_activity_at: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });
});

describe("analytics (§7.5.1)", () => {
  it("is won ÷ closed, one decimal, none before anything closes", () => {
    expect(conversionRate(3, 1)).toEqual({ won: 3, lost: 1, rate: 75 });
    expect(conversionRate(1, 2).rate).toBe(33.3);
    expect(conversionRate(0, 0).rate).toBeNull();
  });

  it("reads the period from the URL: this FY by default, last FY, 90 or 30 days, or a custom range", () => {
    expect(analyticsPeriod({}, "2026-10-23", "2026-27")).toEqual({ preset: "fy", from: "2026-04-01", to: "2027-03-31" });
    expect(analyticsPeriod({ period: "prev_fy" }, "2026-10-23", "2026-27")).toEqual({ preset: "prev_fy", from: "2025-04-01", to: "2026-03-31" });
    expect(analyticsPeriod({ period: "30d" }, "2026-10-23", "2026-27")).toEqual({ preset: "30d", from: "2026-09-24", to: "2026-10-23" });
    expect(analyticsPeriod({ period: "90d" }, "2026-10-23", "2026-27")).toEqual({ preset: "90d", from: "2026-07-26", to: "2026-10-23" });
    expect(analyticsPeriod({ from: "2026-06-01", to: "2026-06-30" }, "2026-10-23", "2026-27")).toEqual({ preset: "custom", from: "2026-06-01", to: "2026-06-30" });
    expect(analyticsPeriod({ from: "2026-06-30", to: "2026-06-01" }, "2026-10-23", "2026-27").preset).toBe("fy");
  });

  it("names services and leads for drafts and titles", () => {
    expect(servicesPhrase(["gst", "income_tax", "audit"])).toMatch(/, .+ and /);
    expect(servicesPhrase([])).toBe("accounting and tax");
    expect(leadTitle({ name: "Ravi Sharma", company: "Sharma Traders" })).toBe("Sharma Traders · Ravi Sharma");
    expect(leadTitle({ name: "Ravi Sharma", company: " " })).toBe("Ravi Sharma");
    expect(parseLeadView("table")).toBe("table");
    expect(parseLeadView("nonsense")).toBe("board");
    expect(parseLeadView(undefined)).toBe("board");
  });
});
