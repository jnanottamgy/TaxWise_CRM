import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  complianceReminderEmail,
  documentRequestEmail,
  emailFirm,
  emailSubject,
  engagementLetterEmail,
  invoiceEmail,
  noticeEmail,
  notificationEmail,
  partnerDigestEmail,
  passwordResetTemplate,
  paymentReceiptEmail,
  paymentReminderEmail,
  portalInviteEmail,
  quotationAcceptedEmail,
  quotationDeclinedEmail,
  quotationFollowUpEmail,
  quotationResponseAlertEmail,
  quotationSentEmail,
  reminderTone,
  staffInviteEmail,
  testEmail,
  welcomeEmail,
  type RenderedEmail,
} from "@/server/email/templates";
import { FOOTER_MARKER, monogram, withFooter } from "@/server/email/templates/layout";
import { defaultFirmProfile } from "@/server/firm";

const firm = emailFirm(defaultFirmProfile());
const APP = "https://app.twchartered.com";

/** Every §10 email, built with realistic data. */
const ALL: Array<[string, RenderedEmail]> = [
  ["staff invite", staffInviteEmail({ name: "CA Anita Rao", email: "anita@twchartered.com", temporaryPassword: "Tw#4fR9q!xZ2", loginUrl: `${APP}/login`, role: "manager", invitedByName: "CA Vinay Karlagere" }, firm)],
  ["staff password reset", staffInviteEmail({ name: "Ravi Kumar", email: "ravi@twchartered.com", temporaryPassword: "Qw!2er#Ty7", loginUrl: `${APP}/login`, role: "employee", reset: true }, firm)],
  ["portal invite", portalInviteEmail({ contactName: "Rakesh Sharma", clientName: "Sharma Traders", email: "rakesh@sharmatraders.in", temporaryPassword: "Pw#9xL2!m", loginUrl: `${APP}/login`, ownerName: "Anita Rao" }, firm)],
  ["welcome", welcomeEmail({ contactName: "Rakesh Sharma", clientName: "Sharma Traders", ownerName: "Anita Rao", ownerEmail: "anita@twchartered.com", ownerPhone: "+91 98450 12345", services: ["GST returns (monthly)", "Income tax return"], portalUrl: `${APP}/portal` }, firm)],
  ["quotation sent", quotationSentEmail({ recipientName: "Rakesh Sharma", quotationNumber: "TW-Q/26-27/0007", totalPaise: 4_130_000, validUntil: "2026-11-21", viewUrl: `${APP}/q/abc`, preparedByName: "Anita Rao", revisionOf: "TW-Q/26-27/0005" }, firm)],
  ["follow-up 3", quotationFollowUpEmail({ day: 3, recipientName: "Rakesh", quotationNumber: "TW-Q/26-27/0007", totalPaise: 4_130_000, validUntil: "2026-11-21", viewUrl: `${APP}/q/abc`, sentOn: "2026-10-22", senderName: "Anita Rao" }, firm)],
  ["follow-up 7", quotationFollowUpEmail({ day: 7, recipientName: "Rakesh", quotationNumber: "TW-Q/26-27/0007", totalPaise: 4_130_000, validUntil: "2026-11-21", viewUrl: `${APP}/q/abc`, sentOn: "2026-10-22", senderName: "Anita Rao" }, firm)],
  ["follow-up 14", quotationFollowUpEmail({ day: 14, recipientName: "Rakesh", quotationNumber: "TW-Q/26-27/0007", totalPaise: 4_130_000, validUntil: "2026-11-21", viewUrl: `${APP}/q/abc`, sentOn: "2026-10-22", senderName: "Anita Rao" }, firm)],
  ["quotation accepted", quotationAcceptedEmail({ recipientName: "Rakesh", quotationNumber: "TW-Q/26-27/0007", totalPaise: 4_130_000, acceptedByName: "Rakesh Sharma", acceptedAt: "2026-10-25T05:30:00Z", ownerName: "Anita Rao" }, firm)],
  ["quotation declined", quotationDeclinedEmail({ recipientName: "Rakesh", quotationNumber: "TW-Q/26-27/0007", reason: "Went with our existing accountant" }, firm)],
  ["quotation alert", quotationResponseAlertEmail({ recipientName: "CA Vinay", response: "accepted", quotationNumber: "TW-Q/26-27/0007", clientName: "Sharma Traders", totalPaise: 4_130_000, respondedAt: "2026-10-25T05:30:00Z", acceptedByName: "Rakesh Sharma", note: "Please start in November", quotationUrl: `${APP}/quotations/1` }, firm)],
  ["invoice", invoiceEmail({ recipientName: "Rakesh", clientName: "Sharma Traders", invoiceNumber: "TW/26-27/0042", invoiceDate: "2026-10-01", dueDate: "2026-10-16", periodLabel: "September fees", totalPaise: 1_180_000, viewPayUrl: `${APP}/portal/invoices/1`, bank: { name: "HDFC Bank", accountName: "TaxWise Consultants", accountNumber: "50200012345678", ifsc: "HDFC0001234", branch: "Sadashiva Nagar" }, upi: { id: "taxwise@hdfcbank", payeeName: "TaxWise Consultants" } }, firm)],
  ["receipt", paymentReceiptEmail({ recipientName: "Rakesh", receiptNumber: "TW-R/26-27/0011", invoiceNumber: "TW/26-27/0042", paymentDate: "2026-10-10", amountReceivedPaise: 1_080_000, tdsPaise: 100_000, methodLabel: "Bank transfer", reference: "UTR 123456", balancePaise: 0 }, firm)],
  ["reminder before", paymentReminderEmail({ stage: "before", days: 3, recipientName: "Rakesh", invoiceNumber: "TW/26-27/0042", invoiceDate: "2026-10-01", dueDate: "2026-10-16", outstandingPaise: 1_180_000, viewPayUrl: `${APP}/portal/invoices/1` }, firm)],
  ["reminder after 15", paymentReminderEmail({ stage: "after", days: 15, recipientName: "Rakesh", invoiceNumber: "TW/26-27/0042", invoiceDate: "2026-10-01", dueDate: "2026-10-16", outstandingPaise: 1_180_000, viewPayUrl: `${APP}/portal/invoices/1`, upi: { id: "taxwise@hdfcbank" } }, firm)],
  ["document request", documentRequestEmail({ recipientName: "Rakesh", clientName: "Sharma Traders", title: "GSTR-3B September 2026", items: [{ title: "Sales register", status: "pending" }, { title: "Purchase invoices", helpText: "All bills above ₹50,000", status: "rejected", rejectionReason: "Pages 3 to 5 are missing" }, { title: "Bank statement", status: "accepted" }], dueDate: "2026-10-15", uploadUrl: `${APP}/portal/documents` }, firm)],
  ["document reminder", documentRequestEmail({ recipientName: "Rakesh", clientName: "Sharma Traders", title: "GSTR-3B September 2026", items: [{ title: "Sales register", status: "pending" }, { title: "Bank statement", status: "uploaded" }], uploadUrl: `${APP}/portal/documents`, reminderNumber: 2 }, firm)],
  ["compliance reminder", complianceReminderEmail({ contactName: "Meena (Accounts)", clientName: "Sharma Traders", complianceLabel: "GSTR-3B", period: "September 2026", explanation: "your monthly GST summary return", dueDate: "2026-10-20", today: "2026-10-15", whatWeNeed: ["Sales register", "Purchase invoices"], portalUrl: `${APP}/portal`, ownerName: "Anita Rao" }, firm)],
  ["engagement letter", engagementLetterEmail({ recipientName: "Rakesh", clientName: "Sharma Traders Pvt Ltd", financialYear: "2026-27", services: ["Statutory audit", "Tax audit"], uploadUrl: `${APP}/portal/documents`, expiresOn: "2027-03-31", partnerName: "CA Vinay Karlagere", isAudit: true }, firm)],
  ["partner digest", partnerDigestEmail({ partnerName: "CA Vinay Karlagere", date: "2026-10-22", deadlines: { total: 7, items: [{ clientName: "Sharma Traders", label: "GSTR-3B Sep 2026", assignee: "Anita Rao" }] }, approvals: { invoices: 2, quotations: 1, leave: 0, dataRequests: 0 }, overdue: { count: 3, totalPaise: 12_345_600, top: [{ clientName: "Gamma LLP", invoiceNumber: "TW/26-27/0012", outstandingPaise: 5_900_000, daysOverdue: 45 }] }, unassigned: { count: 0, top: [] }, links: { dashboard: `${APP}/dashboard`, deadlines: `${APP}/filings`, approvals: `${APP}/inbox`, receivables: `${APP}/invoices?overdue=1`, unassigned: `${APP}/work?unassigned=1` } }, firm)],
  ["notification", notificationEmail({ recipientName: "Anita Rao", title: "Task assigned to you", body: "GSTR-3B for Sharma Traders, due 20 Oct 2026.", linkUrl: `${APP}/work/1` }, firm)],
  ["notice", noticeEmail({ recipientName: "Ravi", title: "You're covering for Anita", paragraphs: ["Anita is on leave until 25 Oct.", "Her clients are on your My clients list."], details: [{ label: "Until", value: "25 Oct 2026, 11:59 pm" }], button: { label: "Open My clients", url: `${APP}/clients` } }, firm)],
  ["test", testEmail({ recipientName: "CA Vinay", sentAt: new Date("2026-10-22T08:35:00Z"), from: "TaxWise Consultants <noreply@twchartered.com>", replyTo: "info@twchartered.com", domain: "twchartered.com" }, firm)],
];

describe("every §10 email", () => {
  it.each(ALL)("%s: subject 'TaxWise Consultants | …', the §7.13.5 footer in both parts, clean text", (_name, mail) => {
    expect(mail.subject).toMatch(/^TaxWise Consultants \| \S/);
    expect(mail.subject).not.toMatch(/\n/);
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("This message was sent by TaxWise Consultants.");
      expect(part).toContain("Powered by J-TACS");
      expect(part).toContain("+91 97405 40239");
      expect(part).toMatch(/Sadashiva Nagar, Bengaluru, Karnataka 560080/);
      expect(part).not.toMatch(/undefined|NaN|\[object Object\]|null/);
    }
    expect(mail.html.startsWith("<!DOCTYPE html><html")).toBe(true);
    expect(mail.text).not.toMatch(/<\/?(p|table|tbody|tr|td|span|div|br|a|h1|hr|img)\b/i);
  });
});

describe("content", () => {
  const get = (name: string) => ALL.find(([n]) => n === name)![1];

  it("money in Indian grouping and dates as 22 Oct 2026", () => {
    expect(get("quotation sent").html).toContain("₹41,300.00");
    expect(get("quotation sent").text).toContain("21 Nov 2026");
    expect(get("partner digest").text).toContain("₹1,23,456.00");
    expect(get("invoice").subject).toBe("TaxWise Consultants | Invoice TW/26-27/0042 for September fees");
  });

  it("the staff invite carries the login, email and temporary password, and two-step sign-in for Managers", () => {
    const m = get("staff invite");
    for (const s of [`${APP}/login`, "anita@twchartered.com", "Tw#4fR9q!xZ2", "set your own password", "two-step sign-in"]) expect(m.text).toContain(s);
    expect(m.html).toContain("Tw#4fR9q!xZ2");
    expect(get("staff password reset").text).not.toContain("two-step");
    expect(m.text).toMatch(/^Dear Anita,/);
  });

  it("the invoice has View & pay, bank and UPI details", () => {
    const t = get("invoice").text;
    for (const s of ["View & pay", "50200012345678", "HDFC0001234", "taxwise@hdfcbank", "₹11,800.00", "16 Oct 2026"]) expect(t).toContain(s);
  });

  it("follow-ups get shorter each time", () => {
    const len = (n: string) => get(n).text.length;
    expect(len("follow-up 3")).toBeGreaterThan(len("follow-up 7"));
    expect(len("follow-up 7")).toBeGreaterThan(len("follow-up 14"));
  });

  it("payment reminders firm up after the due date", () => {
    expect(reminderTone("before", 3)).toBe("gentle");
    expect(reminderTone("after", 1)).toBe("prompt");
    expect(reminderTone("after", 7)).toBe("firm");
    expect(reminderTone("after", 15)).toBe("final");
    expect(get("reminder before").subject).toBe("TaxWise Consultants | Invoice TW/26-27/0042 is due on 16 Oct 2026");
    expect(get("reminder after 15").subject).toBe("TaxWise Consultants | Invoice TW/26-27/0042 is 15 days overdue");
    expect(get("reminder after 15").text).toContain("taxwise@hdfcbank");
  });

  it("document requests list what's pending, with rejection reasons; reminders only what's open", () => {
    const first = get("document request").text;
    expect(first).toContain("Sales register");
    expect(first).toContain("Purchase invoices (please upload again)");
    expect(first).toContain("Why: Pages 3 to 5 are missing");
    expect(first).not.toContain("Bank statement");
    const reminder = get("document reminder");
    expect(reminder.subject).toBe("TaxWise Consultants | Reminder: documents still needed for GSTR-3B September 2026");
    expect(reminder.text).toContain("one item");
    expect(reminder.text).not.toContain("Bank statement");
  });

  it("the compliance reminder says what's due, when, and what we need", () => {
    const m = get("compliance reminder");
    expect(m.subject).toBe("TaxWise Consultants | GSTR-3B for September 2026 is due on 20 Oct 2026");
    expect(m.text).toContain("in 5 days");
    expect(m.text).toMatch(/^Dear Meena/);
    expect(m.text).toContain("What we need from you");
  });

  it("the digest says when there is nothing to do", () => {
    expect(get("partner digest").text).toContain("Every open task has someone on it.");
    // approvals list only what is waiting
    expect(get("partner digest").text).toMatch(/Invoices:\s+2/);
    expect(get("partner digest").text).not.toContain("Leave requests");
  });

  it("the password-reset template keeps Supabase's placeholder intact", () => {
    const t = passwordResetTemplate(firm);
    expect(t.html).toContain(`href="{{ .ConfirmationURL }}"`);
    expect(t.subject).toBe("TaxWise Consultants | Reset your password");
  });

  it("escapes what people typed", () => {
    const m = quotationDeclinedEmail({ recipientName: "<b>Rakesh</b>", quotationNumber: "Q1", reason: `<script>alert("x")</script>` }, firm);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});

describe("the frame", () => {
  it("subjects and the monogram", () => {
    expect(emailSubject(firm, "  Invoice\n TW/1  ")).toBe("TaxWise Consultants | Invoice TW/1");
    expect(monogram("TaxWise Consultants")).toBe("TW");
    expect(monogram("acme partners")).toBe("AP");
  });

  it("adds the footer to an email built elsewhere, in both parts, once", () => {
    const bare = withFooter({ subject: "TaxWise Consultants | Note", text: "Hello.\n\nSee you." }, firm);
    expect(bare.text.match(new RegExp(FOOTER_MARKER, "g"))).toHaveLength(1);
    expect(bare.html).toContain(FOOTER_MARKER);
    expect(bare.html).toContain("<p");
    const doc = withFooter({ subject: "x", text: "Hi", html: "<html><body><p>Hi</p></body></html>" }, firm);
    expect(doc.html).toMatch(/<p>Hi<\/p>[\s\S]*This message was sent by[\s\S]*<\/body>/);
    const fragment = withFooter({ subject: "x", text: "Hi", html: "<p>Custom</p>" }, firm);
    expect(fragment.html).toContain("<p>Custom</p>");
    expect(fragment.html).toContain(FOOTER_MARKER);
    const already = notificationEmail({ recipientName: "A", title: "T", body: "B", linkUrl: `${APP}/x` }, firm);
    const again = withFooter({ subject: already.subject, text: already.text, html: already.html }, firm);
    expect(again).toEqual({ html: already.html, text: already.text });
  });
});
