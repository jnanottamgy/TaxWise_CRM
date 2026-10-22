import { describe, expect, it } from "vitest";
import {
  complianceDisplayStatus,
  getStatus,
  invoiceDisplayStatus,
  isDerivedStatus,
  isKnownStatus,
  STATUS_TONES,
  STATUS_VOCABULARY,
  statusOptions,
  type StatusKind,
} from "@/lib/status";
import {
  COMPLIANCE_TYPES,
  DB_ENUMS,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPES,
  INVOICE_STATUSES,
  isEnumValue,
  SERVICE_FREQUENCIES,
  SERVICE_TYPES,
  type DbEnumName,
} from "@/lib/domain/enums";

const labels = (kind: StatusKind) => statusOptions(kind).map((o) => o.label);
const tone = (kind: StatusKind, value: string) => getStatus(kind, value).tone;

describe("enums (§5.1)", () => {
  it("lists every enum type", () => {
    expect(Object.keys(DB_ENUMS)).toHaveLength(49);
  });

  it("has the exact values for the law-table enums", () => {
    expect([...COMPLIANCE_TYPES]).toEqual(["gstr_1", "gstr_3b", "tds", "roc", "itr", "pf_esic", "audit", "advance_tax", "pt", "custom"]);
    expect([...SERVICE_FREQUENCIES]).toEqual(["monthly", "quarterly", "annual", "one_time"]);
    expect([...SERVICE_TYPES]).toEqual(["gst", "income_tax", "tds", "payroll", "bookkeeping", "audit", "company_law", "incorporation", "other"]);
  });

  it("keeps derived 'overdue' out of the stored enums", () => {
    expect(DB_ENUMS.invoice_status).not.toContain("overdue");
    expect(DB_ENUMS.compliance_status).not.toContain("overdue");
  });

  it("has no duplicate values in any enum", () => {
    for (const [name, values] of Object.entries(DB_ENUMS)) {
      expect(new Set(values).size, name).toBe(values.length);
      for (const v of values) expect(v, name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("isEnumValue", () => {
    expect(isEnumValue("task_status", "filed_done")).toBe(true);
    expect(isEnumValue("task_status", "done")).toBe(false);
    expect(isEnumValue("invoice_status", "overdue")).toBe(false);
    expect(isEnumValue("app_role", 1)).toBe(false);
  });

  it("labels every entity type with the wizard's wording (§7.3.2)", () => {
    expect(Object.keys(ENTITY_TYPE_LABELS)).toEqual([...ENTITY_TYPES]);
    expect(ENTITY_TYPE_LABELS.pvt_ltd).toBe("Private limited company");
    expect(ENTITY_TYPE_LABELS.proprietorship).toBe("Sole proprietorship");
  });
});

describe("status vocabulary (§3.6)", () => {
  it("covers every §3.6 vocabulary", () => {
    expect(Object.keys(STATUS_VOCABULARY)).toEqual([
      "client_status",
      "client_priority",
      "task_status",
      "task_acceptance",
      "task_priority",
      "lead_status",
      "quotation_status",
      "invoice_status",
      "compliance_status",
      "compliance_workflow",
      "notice_status",
      "attendance_status",
      "engagement_status",
      "request_item_status",
      "registration_status",
      "dsc_status",
      "leave_status",
      "whatsapp_group_status",
    ]);
  });

  it("has exactly the enum's values (plus derived overdue where the spec says)", () => {
    for (const kind of Object.keys(STATUS_VOCABULARY) as StatusKind[]) {
      const enumValues = [...DB_ENUMS[kind as DbEnumName]];
      const expected = kind === "invoice_status" || kind === "compliance_status" ? [...enumValues, "overdue"] : enumValues;
      expect(Object.keys(STATUS_VOCABULARY[kind]).sort(), kind).toEqual(expected.sort());
    }
  });

  it("every entry has a label, a known tone and a meaning that starts with the label", () => {
    for (const [kind, map] of Object.entries(STATUS_VOCABULARY)) {
      for (const [value, info] of Object.entries(map)) {
        const where = `${kind}.${value}`;
        expect(info.label.length, where).toBeGreaterThan(0);
        expect(STATUS_TONES, where).toContain(info.tone);
        expect(info.meaning.startsWith(`${info.label}`), where).toBe(true);
        expect(info.meaning, where).toMatch(/: .+\.$/);
      }
    }
  });

  it("uses the spec's example meaning for Data awaited", () => {
    expect(getStatus("task_status", "data_awaited")).toEqual({
      label: "Data awaited",
      tone: "warning",
      meaning: "Data awaited: blocked on the client. Shows on the manager's call list.",
    });
  });

  it("client status: labels and tones", () => {
    expect(labels("client_status")).toEqual(["Active", "Pending", "On hold", "Inactive"]);
    expect(tone("client_status", "active")).toBe("success");
    expect(tone("client_status", "pending")).toBe("warning");
    expect(tone("client_status", "on_hold")).toBe("violet");
    expect(tone("client_status", "inactive")).toBe("muted");
    expect(getStatus("client_status", "active").meaning).toBe("Active: included in billing runs, reminders and work allocation.");
    expect(getStatus("client_status", "on_hold").meaning).toContain("auto-invoicing");
  });

  it("priorities", () => {
    expect(labels("client_priority")).toEqual(["Low", "Medium", "High", "Critical"]);
    expect(labels("task_priority")).toEqual(["Low", "Medium", "High", "Urgent"]);
  });

  it("task status: Filed / Done shows as Filed; tones per §3.6", () => {
    expect(labels("task_status")).toEqual(["Not started", "In progress", "Data awaited", "Under review", "Filed", "On hold"]);
    expect(tone("task_status", "not_started")).toBe("muted");
    expect(tone("task_status", "in_progress")).toBe("info");
    expect(tone("task_status", "data_awaited")).toBe("warning");
    expect(tone("task_status", "under_review")).toBe("violet");
    expect(tone("task_status", "filed_done")).toBe("success");
    expect(tone("task_status", "on_hold")).toBe("muted");
    expect(getStatus("task_status", "filed_done").meaning).toContain("Manager or Partner");
  });

  it("follows the writing voice: Filed, not Completed; Data awaited, not Blocked (§3.4)", () => {
    for (const info of Object.values(STATUS_VOCABULARY.task_status)) {
      expect(info.label).not.toMatch(/Completed|Blocked|Done/);
    }
  });

  it("task acceptance", () => {
    expect(labels("task_acceptance")).toEqual(["Waiting for acceptance", "Accepted", "Declined"]);
    expect(getStatus("task_acceptance", "declined").meaning).toContain("reason");
  });

  it("lead stages", () => {
    expect(labels("lead_status")).toEqual([
      "New lead",
      "Contacted",
      "Quotation requested",
      "Follow-up required",
      "Client will revert",
      "Proposal sent",
      "Negotiation",
      "Won",
      "Lost",
    ]);
    expect(tone("lead_status", "won")).toBe("success");
    expect(tone("lead_status", "lost")).toBe("danger");
  });

  it("quotation status", () => {
    expect(labels("quotation_status")).toEqual([
      "Draft",
      "Pending approval",
      "Approved",
      "Sent",
      "Viewed",
      "Accepted",
      "Rejected",
      "Expired",
      "Superseded",
    ]);
    expect(tone("quotation_status", "accepted")).toBe("success");
    expect(tone("quotation_status", "rejected")).toBe("danger");
    expect(tone("quotation_status", "expired")).toBe("muted");
    expect(tone("quotation_status", "superseded")).toBe("muted");
    expect(tone("quotation_status", "sent")).toBe("info");
    expect(getStatus("quotation_status", "superseded").meaning).toContain("no longer");
  });

  it("invoice status, including derived Overdue", () => {
    expect(labels("invoice_status")).toEqual([
      "Draft",
      "Awaiting approval",
      "Sent",
      "Partially paid",
      "Paid",
      "Overdue",
      "Disputed",
      "Waived",
    ]);
    expect(tone("invoice_status", "sent")).toBe("info");
    expect(tone("invoice_status", "partially_paid")).toBe("warning");
    expect(tone("invoice_status", "paid")).toBe("success");
    expect(tone("invoice_status", "overdue")).toBe("danger");
    expect(tone("invoice_status", "disputed")).toBe("violet");
    expect(tone("invoice_status", "waived")).toBe("muted");
    expect(getStatus("invoice_status", "paid").meaning).toContain("never by hand");
    expect(getStatus("invoice_status", "partially_paid").meaning).toContain("never by hand");
    expect(getStatus("invoice_status", "draft").meaning).toContain("never overdue");
  });

  it("compliance status and workflow", () => {
    expect(labels("compliance_status")).toEqual(["Pending", "Completed", "Overdue", "Cancelled"]);
    expect(tone("compliance_status", "overdue")).toBe("danger");
    expect(labels("compliance_workflow")).toEqual(["Not started", "Documents awaited", "In progress", "Under review", "Filed", "Completed"]);
    expect(getStatus("compliance_workflow", "documents_awaited").shortLabel).toBe("Docs awaited"); // filings grid, §7.7
  });

  it("notices, attendance, engagement letters, request items", () => {
    expect(labels("notice_status")).toEqual([
      "Open",
      "Reply drafted",
      "Replied",
      "Hearing",
      "Closed (favourable)",
      "Closed (unfavourable)",
      "Closed (partial)",
    ]);
    expect(labels("attendance_status")).toEqual(["Present", "Late login", "Half day", "Absent", "On leave"]);
    expect(labels("engagement_status")).toEqual(["Draft", "Issued", "Signed", "Declined", "Expired"]);
    expect(labels("request_item_status")).toEqual(["Pending", "Uploaded", "Accepted", "Rejected"]);
    expect(getStatus("request_item_status", "rejected").meaning).toContain("reason");
    expect(tone("attendance_status", "absent")).toBe("danger");
    expect(tone("notice_status", "closed_unfavourable")).toBe("danger");
  });

  it("registrations, DSCs, leave and WhatsApp groups", () => {
    expect(labels("registration_status")).toEqual(["Active", "Expired", "Surrendered", "Cancelled"]);
    expect(labels("dsc_status")).toEqual(["Active", "Expired", "Revoked"]);
    expect(labels("leave_status")).toEqual(["Requested", "Approved", "Declined", "Cancelled"]);
    expect(labels("whatsapp_group_status")).toEqual(["To create", "Active", "Closed"]);
    expect(tone("dsc_status", "expired")).toBe("danger");
    expect(tone("registration_status", "active")).toBe("success");
  });
});

describe("getStatus, statusOptions and helpers", () => {
  it("falls back gracefully for unknown values", () => {
    expect(getStatus("task_status", "parked_somewhere")).toEqual({ label: "Parked somewhere", tone: "neutral", meaning: "Parked somewhere." });
    expect(getStatus("task_status", null)).toEqual({ label: "Unknown", tone: "neutral", meaning: "Unknown." });
    expect(getStatus("task_status", "toString").label).toBe("ToString");
  });

  it("isKnownStatus and isDerivedStatus", () => {
    expect(isKnownStatus("invoice_status", "overdue")).toBe(true);
    expect(isKnownStatus("invoice_status", "cancelled")).toBe(false);
    expect(isKnownStatus("task_status", 3)).toBe(false);
    expect(isDerivedStatus("invoice_status", "overdue")).toBe(true);
    expect(isDerivedStatus("compliance_status", "overdue")).toBe(true);
    expect(isDerivedStatus("invoice_status", "sent")).toBe(false);
    expect(isDerivedStatus("task_status", "overdue")).toBe(false);
  });

  it("statusOptions keeps spec order and can drop derived values", () => {
    const opts = statusOptions("invoice_status");
    expect(opts[0]).toEqual({ value: "draft", label: "Draft", tone: "muted", derived: false });
    expect(opts.find((o) => o.value === "overdue")?.derived).toBe(true);
    expect(statusOptions("invoice_status", { includeDerived: false }).map((o) => o.value)).toEqual([...INVOICE_STATUSES]);
  });

  it("a draft invoice is never overdue (§7.9.3)", () => {
    expect(invoiceDisplayStatus("draft", true)).toBe("draft");
    expect(invoiceDisplayStatus("awaiting_approval", true)).toBe("awaiting_approval");
    expect(invoiceDisplayStatus("sent", true)).toBe("overdue");
    expect(invoiceDisplayStatus("partially_paid", true)).toBe("overdue");
    expect(invoiceDisplayStatus("paid", true)).toBe("paid");
    expect(invoiceDisplayStatus("disputed", true)).toBe("disputed");
    expect(invoiceDisplayStatus("waived", true)).toBe("waived");
    expect(invoiceDisplayStatus("sent", false)).toBe("sent");
    expect(invoiceDisplayStatus("sent", null)).toBe("sent");
  });

  it("only pending compliance events show as overdue", () => {
    expect(complianceDisplayStatus("pending", true)).toBe("overdue");
    expect(complianceDisplayStatus("completed", true)).toBe("completed");
    expect(complianceDisplayStatus("cancelled", true)).toBe("cancelled");
    expect(complianceDisplayStatus("pending", false)).toBe("pending");
    expect(complianceDisplayStatus("pending", undefined)).toBe("pending");
  });
});
