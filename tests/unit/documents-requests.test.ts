import { describe, expect, it } from "vitest";
import { addDays, todayIST } from "@/lib/domain/fy";
import {
  CreateDocumentRequestSchema,
  ReviewRequestItemSchema,
  nextReminderOn,
  outstandingLines,
  progressLabel,
  requestHandoffDraft,
  requestHandoffSubject,
  requestPortalPath,
  requestProgress,
  type ItemLike,
} from "@/lib/schemas/document-requests";
import { RequestUploadSlotsSchema, UpdateDocumentSchema, resolveDocumentSubtab } from "@/lib/schemas/documents";

const CLIENT = "0b6a1f6e-2d7c-4c1e-9f3a-5d8e7c6b5a40";
const item = (status: ItemLike["status"], is_required = true): ItemLike => ({ status, is_required });

describe("request progress (§7.14 'completes when every required item is accepted'; mirrors 0122)", () => {
  it("completes when every required item is accepted, whatever the optional ones say", () => {
    expect(requestProgress([item("accepted"), item("pending", false)]).complete).toBe(true);
    expect(requestProgress([item("accepted"), item("uploaded")]).complete).toBe(false);
    expect(requestProgress([item("accepted"), item("rejected")]).complete).toBe(false);
  });

  it("with only optional items, every item must be accepted; with none, it isn't complete", () => {
    expect(requestProgress([item("accepted", false), item("pending", false)]).complete).toBe(false);
    expect(requestProgress([item("accepted", false), item("accepted", false)]).complete).toBe(true);
    expect(requestProgress([]).complete).toBe(false);
  });

  it("counts what is to review and what is still needed from the client", () => {
    const p = requestProgress([item("pending"), item("rejected"), item("uploaded"), item("accepted"), item("pending", false)]);
    expect(p).toMatchObject({ total: 5, required: 4, accepted: 1, requiredAccepted: 1, toReview: 1, pending: 2, rejected: 1, outstanding: 3, complete: false });
    expect(progressLabel(p)).toBe("1 of 5 accepted · 1 to review · 1 sent back");
    expect(progressLabel(requestProgress([]))).toBe("No items");
  });
});

describe("reminder cadence (§7.14 'Reminder every N days … Reminders stop when nothing is pending')", () => {
  it("is N days after the last reminder, or after the request was made", () => {
    expect(nextReminderOn({ status: "open", lastRemindedAt: "2026-10-20T04:30:00Z", createdAt: "2026-10-01T04:30:00Z", everyDays: 3, outstanding: 2 })).toBe("2026-10-23");
    expect(nextReminderOn({ status: "open", lastRemindedAt: null, createdAt: "2026-10-21T20:00:00Z", everyDays: 3, outstanding: 1 })).toBe("2026-10-25"); // 22 Oct in IST
  });

  it("stops when the request is closed or nothing is outstanding", () => {
    expect(nextReminderOn({ status: "completed", lastRemindedAt: null, createdAt: "2026-10-21T04:00:00Z", everyDays: 3, outstanding: 1 })).toBeNull();
    expect(nextReminderOn({ status: "cancelled", lastRemindedAt: null, createdAt: "2026-10-21T04:00:00Z", everyDays: 3, outstanding: 1 })).toBeNull();
    expect(nextReminderOn({ status: "open", lastRemindedAt: null, createdAt: "2026-10-21T04:00:00Z", everyDays: 3, outstanding: 0 })).toBeNull();
  });
});

describe("hand-off drafts carry the outstanding items and the portal link (§7.13.2, §7.14)", () => {
  const items = [
    { title: "Bank statement Apr–Sep", status: "pending" as const, is_required: true },
    { title: "Rent agreement", status: "pending" as const, is_required: false },
    { title: "Purchase invoices", status: "rejected" as const, is_required: true, rejection_reason: "Pages 3 to 5 are missing" },
    { title: "PAN card", status: "accepted" as const, is_required: true },
    { title: "Sales register", status: "uploaded" as const, is_required: true },
  ];

  it("lists pending and rejected items only, rejected ones with the reason", () => {
    expect(outstandingLines(items)).toEqual([
      "• Bank statement Apr–Sep",
      "• Rent agreement (if you have it)",
      "• Purchase invoices: please send again (Pages 3 to 5 are missing)",
    ]);
  });

  it("drafts the message and the subject", () => {
    const link = `https://app.twchartered.com${requestPortalPath("9d3c2b1a-0f4e-4d5c-8b7a-6e5d4c3b2a10")}`;
    expect(link).toBe("https://app.twchartered.com/portal/documents?request=9d3c2b1a-0f4e-4d5c-8b7a-6e5d4c3b2a10");
    const draft = requestHandoffDraft({ contactName: "Rakesh", clientName: "Sharma Traders", title: "Audit PBC FY 2026-27", items, dueDateText: "31 Oct 2026", portalLink: link });
    expect(draft.split("\n")[0]).toBe("Hi Rakesh,");
    expect(draft).toContain('For "Audit PBC FY 2026-27" (Sharma Traders) we need the following by 31 Oct 2026:');
    expect(draft.endsWith(`You can upload them here: ${link}`)).toBe(true);
    const reminder = requestHandoffDraft({ contactName: null, clientName: "Sharma Traders", title: "Audit PBC", items: [], dueDateText: null, portalLink: link, reminder: true });
    expect(reminder.startsWith("Hello,")).toBe(true);
    expect(reminder).toContain("• Nothing is pending right now.");
    expect(requestHandoffSubject("TaxWise Consultants", "Audit PBC")).toBe("TaxWise Consultants | Documents needed for Audit PBC");
    expect(requestHandoffSubject("TaxWise Consultants", "Audit PBC", true)).toBe("TaxWise Consultants | Reminder: documents still needed for Audit PBC");
  });
});

describe("request and review schemas", () => {
  it("needs a title and at least one titled item; defaults reminders to every 3 days", () => {
    const r = CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "Audit PBC", items: [{ title: "Trial balance" }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ reminderEveryDays: 3, sendEmail: true, contactId: null, items: [{ title: "Trial balance", isRequired: true, helpText: null }] });
    expect(CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: " ", items: [{ title: "x" }] }).success).toBe(false);
    expect(CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "x", items: [] }).success).toBe(false);
    expect(CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "x", items: [{ title: "" }] }).success).toBe(false);
    expect(CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "x", items: [{ title: "a" }], reminderEveryDays: 0 }).success).toBe(false);
    expect(CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "x", items: [{ title: "a" }], reminderEveryDays: "7" }).success).toBe(true);
  });

  it("refuses a due date in the past", () => {
    const yesterday = addDays(todayIST(), -1);
    const r = CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "x", items: [{ title: "a" }], dueDate: yesterday });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["dueDate"]);
    expect(CreateDocumentRequestSchema.safeParse({ clientId: CLIENT, title: "x", items: [{ title: "a" }], dueDate: todayIST() }).success).toBe(true);
  });

  it("a rejection needs a reason", () => {
    const base = { id: CLIENT, requestId: CLIENT, clientId: CLIENT, updatedAt: "2026-10-22T10:00:00Z" };
    expect(ReviewRequestItemSchema.safeParse({ ...base, decision: "accept" }).success).toBe(true);
    expect(ReviewRequestItemSchema.safeParse({ ...base, decision: "reject", reason: "  " }).success).toBe(false);
    expect(ReviewRequestItemSchema.safeParse({ ...base, decision: "reject", reason: "Blurred scan" }).success).toBe(true);
  });
});

describe("upload and document schemas", () => {
  const file = { key: "f1", fileName: "GST cert.pdf", size: 1000, mimeType: "application/pdf", title: "GST certificate" };

  it("takes up to 20 described files; a version or request item takes exactly one", () => {
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: [file] }).success).toBe(true);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: Array.from({ length: 21 }, (_, i) => ({ ...file, key: `f${i}` })) }).success).toBe(false);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, purpose: "new_version", files: [file] }).success).toBe(false);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, purpose: "new_version", documentId: CLIENT, files: [file, { ...file, key: "f2" }] }).success).toBe(false);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, purpose: "request_item", requestItemId: CLIENT, files: [file] }).success).toBe(true);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: [{ ...file, mimeType: "application/zip" }] }).success).toBe(false);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: [{ ...file, size: 26214401 }] }).success).toBe(false);
  });

  it("cleans tags (trimmed, unique ignoring case) and checks dates", () => {
    const r = RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: [{ ...file, tags: [" GST ", "gst", "Bank  statement", ""] }] });
    expect(r.success && r.data.files[0].tags).toEqual(["GST", "Bank statement"]);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: [{ ...file, expiryDate: "2027-01-31", renewalDate: "2027-03-01" }] }).success).toBe(false);
    expect(RequestUploadSlotsSchema.safeParse({ clientId: CLIENT, files: [{ ...file, financialYear: "2026-28" }] }).success).toBe(false);
  });

  it("a confidential document can't also be shared with the client", () => {
    const base = { id: CLIENT, clientId: CLIENT, updatedAt: "x", title: "PAN", category: "kyc", tags: [], isConfidential: true, shareableWithClient: true, retentionUntil: "2033-10-23" };
    expect(UpdateDocumentSchema.safeParse(base).success).toBe(false);
    expect(UpdateDocumentSchema.safeParse({ ...base, shareableWithClient: false }).success).toBe(true);
  });

  it("resolves the Documents sub-tab", () => {
    expect(resolveDocumentSubtab("requests")).toBe("requests");
    expect(resolveDocumentSubtab(["checklist"])).toBe("checklist");
    expect(resolveDocumentSubtab("bogus")).toBe("vault");
    expect(resolveDocumentSubtab(undefined)).toBe("vault");
  });
});
