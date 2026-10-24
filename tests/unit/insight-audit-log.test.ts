import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUDIT_EVENTS } from "@/lib/domain/enums";
import { AUDIT_EVENT_LABEL, auditDetailsView, auditEventLabel, auditValueText, humanise, roleLabel } from "@/components/audit-log/audit-format";
import { auditQueryParams } from "@/lib/data/audit-log";

describe("audit event labels (§5.1 audit_event)", () => {
  it("names every event in plain words", () => {
    for (const e of AUDIT_EVENTS) expect(AUDIT_EVENT_LABEL[e]).toMatch(/^[A-Z][a-z -]+$/);
    expect(auditEventLabel("credential_viewed")).toBe("Portal password revealed");
    expect(auditEventLabel("something_new")).toBe("Something new");
  });

  it("humanises resource types, keeping the trade's acronyms", () => {
    expect(humanise("client_covers")).toBe("Client covers");
    expect(humanise("gst_recon_run")).toBe("GST recon run");
    expect(humanise("udin_record")).toBe("UDIN record");
    expect(humanise(null)).toBe("");
    expect(roleLabel("manager")).toBe("Manager");
    expect(roleLabel(null)).toBe("");
  });
});

describe("auditDetailsView (§7.20 before/after)", () => {
  it("lists only the fields that changed when before and after are objects", () => {
    const v = auditDetailsView({ before: { name: "Sharma & Co", notes: "a" }, after: { name: "Sharma and Co", notes: "a" }, client_id: "x" });
    expect(v.changes).toEqual([{ field: "Name", before: "Sharma & Co", after: "Sharma and Co" }]);
    expect(v.other).toEqual([{ label: "Client ID", value: "x" }]);
  });

  it("shows every field when nothing differs (an event that recorded its state)", () => {
    const v = auditDetailsView({ before: { deleted: true }, after: { deleted: true } });
    expect(v.changes).toHaveLength(1);
  });

  it("reads a single field change and a changes list", () => {
    expect(auditDetailsView({ field: "status", before: "pending", after: "active", reason: "Onboarded" })).toEqual({
      changes: [{ field: "Status", before: "pending", after: "active" }],
      other: [{ label: "Reason", value: "Onboarded" }],
    });
    expect(auditDetailsView({ before: "2026-10-25T18:29:59Z", after: "2026-10-27T18:29:59Z" }).changes).toEqual([{ field: "Value", before: "2026-10-25T18:29:59Z", after: "2026-10-27T18:29:59Z" }]);
    const list = auditDetailsView({ group_id: "g", changes: [{ client_id: "c1", before: null, after: "g" }, { field: "owner_employee_id", before: "e1", after: "e2" }] });
    expect(list.changes).toEqual([
      { field: "c1", before: null, after: "g" },
      { field: "Owner employee ID", before: "e1", after: "e2" },
    ]);
    expect(list.other).toEqual([{ label: "Group ID", value: "g" }]);
  });

  it("copes with no details and with details that aren't an object", () => {
    expect(auditDetailsView(null)).toEqual({ changes: [], other: [] });
    expect(auditDetailsView("text")).toEqual({ changes: [], other: [{ label: "Details", value: "text" }] });
  });

  it("formats values for the drawer", () => {
    expect(auditValueText(null)).toBe("—");
    expect(auditValueText(true)).toBe("Yes");
    expect(auditValueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("auditQueryParams (the page's URL state → audit_log_page)", () => {
  const base = { q: "", dir: "desc" as const };
  it("turns a period into IST dates ending today", () => {
    expect(auditQueryParams({ ...base, filters: { period: ["7"] } }, "2026-10-24")).toMatchObject({ from: "2026-10-18", to: "2026-10-24" });
    expect(auditQueryParams({ ...base, filters: { period: ["today"] } }, "2026-10-24")).toMatchObject({ from: "2026-10-24", to: "2026-10-24" });
  });

  it("prefers an explicit range, and ignores malformed dates and ids", () => {
    expect(auditQueryParams({ ...base, filters: { from: ["2026-09-01"], to: ["2026-09-30"], period: ["7"] } }, "2026-10-24")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(auditQueryParams({ ...base, filters: { from: ["yesterday"], user: ["not-a-uuid"] } }, "2026-10-24")).toMatchObject({ from: null, user_id: null, system: false });
  });

  it("reads the system pseudo-person, outcomes and events", () => {
    const p = auditQueryParams({ ...base, filters: { user: ["system"], outcome: ["failure"], event: ["login_failure", "access_denied"] } }, "2026-10-24");
    expect(p).toMatchObject({ system: true, success: false, events: ["login_failure", "access_denied"] });
  });
});
