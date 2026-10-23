import { describe, expect, it } from "vitest";
import {
  CLIENT_CHANNELS,
  clientChannels,
  clientRemindersPaused,
  complianceServiceType,
  documentDateToFlag,
  isComplianceReminderDue,
  reminderWindowStart,
} from "@/lib/domain/reminders";
import { COMPLIANCE_TYPES } from "@/lib/domain/enums";

const TODAY = "2026-10-23";

describe("complianceServiceType", () => {
  it("maps each return to the service whose contact handles it", () => {
    expect(complianceServiceType("gstr_1")).toBe("gst");
    expect(complianceServiceType("gstr_3b")).toBe("gst");
    expect(complianceServiceType("tds")).toBe("tds");
    expect(complianceServiceType("itr")).toBe("income_tax");
    expect(complianceServiceType("advance_tax")).toBe("income_tax");
    expect(complianceServiceType("roc")).toBe("company_law");
    expect(complianceServiceType("pf_esic")).toBe("payroll");
    expect(complianceServiceType("pt")).toBe("payroll");
    expect(complianceServiceType("audit")).toBe("audit");
    expect(complianceServiceType("custom")).toBeNull();
  });

  it("knows every compliance type", () => {
    for (const t of COMPLIANCE_TYPES.filter((t) => t !== "custom")) expect(complianceServiceType(t), t).not.toBeNull();
  });
});

describe("isComplianceReminderDue", () => {
  const event = { status: "pending" as const, dueDate: "2026-10-30", reminderDays: 7, reminderSentAt: null };

  it("is due from reminder_days before the date until the date itself", () => {
    expect(isComplianceReminderDue(event, "2026-10-22")).toBe(false);
    expect(isComplianceReminderDue(event, "2026-10-23")).toBe(true);
    expect(isComplianceReminderDue(event, "2026-10-30")).toBe(true);
    expect(isComplianceReminderDue(event, "2026-10-31")).toBe(false);
  });

  it("reminds once, and never for a filed or cancelled deadline", () => {
    expect(isComplianceReminderDue({ ...event, reminderSentAt: "2026-10-23T03:30:00Z" }, TODAY)).toBe(false);
    expect(isComplianceReminderDue({ ...event, status: "completed" }, TODAY)).toBe(false);
    expect(isComplianceReminderDue({ ...event, status: "cancelled" }, TODAY)).toBe(false);
  });

  it("treats a zero or negative lead as the due date only", () => {
    expect(isComplianceReminderDue({ ...event, reminderDays: 0 }, "2026-10-29")).toBe(false);
    expect(isComplianceReminderDue({ ...event, reminderDays: 0 }, "2026-10-30")).toBe(true);
    expect(isComplianceReminderDue({ ...event, reminderDays: -3 }, "2026-10-30")).toBe(true);
    expect(reminderWindowStart("2026-10-30", 7)).toBe("2026-10-23");
  });
});

describe("clientChannels", () => {
  it("uses the client's own channels, else the firm's defaults, in a fixed order", () => {
    expect(clientChannels(["portal", "email"], ["whatsapp"])).toEqual(["email", "portal"]);
    expect(clientChannels([], ["whatsapp", "email"])).toEqual(["email", "whatsapp"]);
    expect(clientChannels(null, null)).toEqual([]);
    expect(clientChannels(["sms"], ["email"])).toEqual(["email"]);
    expect(CLIENT_CHANNELS).toEqual(["email", "whatsapp", "portal"]);
  });
});

describe("clientRemindersPaused", () => {
  it("pauses On hold and Inactive clients and those in the recycle bin", () => {
    expect(clientRemindersPaused({ status: "active", deletedAt: null })).toBe(false);
    expect(clientRemindersPaused({ status: "pending", deletedAt: null })).toBe(false);
    expect(clientRemindersPaused({ status: "on_hold", deletedAt: null })).toBe(true);
    expect(clientRemindersPaused({ status: "inactive", deletedAt: null })).toBe(true);
    expect(clientRemindersPaused({ status: "active", deletedAt: "2026-10-01T00:00:00Z" })).toBe(true);
  });
});

describe("documentDateToFlag", () => {
  it("flags an expiry within 30 days, then a renewal, and nothing past or further out", () => {
    expect(documentDateToFlag({ expiryDate: "2026-11-10", renewalDate: null }, TODAY)).toEqual({ kind: "expiry", date: "2026-11-10" });
    expect(documentDateToFlag({ expiryDate: "2026-11-22", renewalDate: null }, TODAY)).toEqual({ kind: "expiry", date: "2026-11-22" });
    expect(documentDateToFlag({ expiryDate: "2026-11-23", renewalDate: null }, TODAY)).toBeNull();
    expect(documentDateToFlag({ expiryDate: "2026-10-22", renewalDate: null }, TODAY)).toBeNull();
    expect(documentDateToFlag({ expiryDate: "2027-03-31", renewalDate: "2026-11-01" }, TODAY)).toEqual({ kind: "renewal", date: "2026-11-01" });
    expect(documentDateToFlag({ expiryDate: null, renewalDate: null }, TODAY)).toBeNull();
    expect(documentDateToFlag({ expiryDate: "2026-10-30", renewalDate: null }, TODAY, 5)).toBeNull();
  });
});
