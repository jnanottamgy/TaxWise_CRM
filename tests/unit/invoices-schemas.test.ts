import { describe, expect, it } from "vitest";
import {
  INVOICE_EXPORT_MAX_ROWS,
  SaveInvoiceSchema,
  agreedFeeNotes,
  datePresetRange,
  draftPayload,
  duplicatePeriodOnForm,
  engagementLine,
  formTotals,
  hoursLabel,
  invoiceActions,
  invoiceExportTable,
  invoiceShareText,
  isBlankLine,
  isReportedInGstr1,
  lineIssues,
  listFinancialYear,
  periodChoices,
  sacForService,
  sentViaLabel,
  toCsv,
  unbilledTimeLines,
  workRule47Warning,
  type InvoiceActionState,
  type InvoiceExportRow,
  type InvoiceLineValues,
  type UnbilledEntry,
} from "@/lib/schemas/invoices";

const CLIENT = "0b6f2b1e-1c55-4d5a-9a3e-5f2f8a1f0c01";
const SERVICE = "6a1c4a22-8d1e-4b0b-9f33-0c8e8f6b2a10";
const TASK = "a9d3b8a4-2e6f-4f0c-8a5b-1d2c3e4f5a6b";
const ENTRY_1 = "11111111-1111-4111-8111-111111111111";
const ENTRY_2 = "22222222-2222-4222-8222-222222222222";
const ENTRY_3 = "33333333-3333-4333-8333-333333333333";

function line(over: Partial<InvoiceLineValues> = {}): InvoiceLineValues {
  return {
    key: "",
    description: "GST compliance for Sep 2026",
    service_type: "gst",
    sac_code: "998231",
    quantity: "1",
    rate: "10000",
    tax_rate: "18",
    tax_rate_reason: "",
    is_reimbursement: false,
    client_service_id: "",
    source_task_id: "",
    time_entry_ids: [],
    source_label: "",
    ...over,
  };
}

describe("formTotals (§6.3, §6.4: the editor's totals match save_invoice_draft)", () => {
  it("splits CGST + SGST for an intra-state supply", () => {
    const t = formTotals([line()], "29", "29", false);
    expect(t.taxablePaise).toBe(1_000_000);
    expect(t.cgstPaise).toBe(90_000);
    expect(t.sgstPaise).toBe(90_000);
    expect(t.igstPaise).toBe(0);
    expect(t.totalPaise).toBe(1_180_000);
    expect(t.linePaise).toEqual([1_000_000]);
  });

  it("charges IGST for an inter-state supply and keeps reimbursements outside the taxable value", () => {
    const t = formTotals([line(), line({ description: "Reimbursement of ROC fees (pure agent)", rate: "600", tax_rate: "0", is_reimbursement: true })], "27", "29", false);
    expect(t.igstPaise).toBe(180_000);
    expect(t.cgstPaise + t.sgstPaise).toBe(0);
    expect(t.reimbursementPaise).toBe(60_000);
    expect(t.totalPaise).toBe(1_000_000 + 180_000 + 60_000);
  });

  it("rounds off to whole rupees only when asked", () => {
    const lines = [line({ rate: "1234.56" })];
    const exact = formTotals(lines, "29", "29", false);
    const rounded = formTotals(lines, "29", "29", true);
    expect(exact.roundOffPaise).toBe(0);
    expect(rounded.totalPaise % 100).toBe(0);
    expect(Math.abs(rounded.roundOffPaise)).toBeLessThan(100);
    expect(rounded.totalPaise - rounded.roundOffPaise).toBe(exact.totalPaise);
  });

  it("multiplies quantity by rate and counts unreadable lines as ₹0", () => {
    const t = formTotals([line({ quantity: "2.5", rate: "1000" }), line({ rate: "abc" })], "29", "29", false);
    expect(t.linePaise).toEqual([250_000, 0]);
  });

  it("falls back to the firm's state when the place of supply is blank", () => {
    expect(formTotals([line()], "", "29", false).intraState).toBe(true);
  });
});

describe("lineIssues and the save schema (§7.9.2)", () => {
  it("skips blank lines and checks the rest", () => {
    expect(isBlankLine({ description: " ", rate: "" })).toBe(true);
    expect(isBlankLine({ description: "", rate: "0" })).toBe(true);
    const issues = lineIssues([line({ description: "", rate: "" }), line({ description: "", quantity: "0", tax_rate: "180", sac_code: "1234" })], true);
    const paths = issues.map((i) => i.path);
    expect(paths).not.toContain("lines.0.description");
    expect(paths).toEqual(expect.arrayContaining(["lines.1.description", "lines.1.quantity", "lines.1.tax_rate", "lines.1.sac_code"]));
  });

  it("allows a ₹0 rate while autosaving but not when saving for real", () => {
    const zero = [line({ rate: "" })];
    expect(lineIssues(zero, false)).toEqual([]);
    expect(lineIssues(zero, true).map((i) => i.path)).toEqual(["lines.0.rate"]);
  });

  it("refuses a due date before the invoice date and an invoice with no lines", () => {
    const r = SaveInvoiceSchema.safeParse({ client_id: CLIENT, issue_date: "2026-10-22", due_date: "2026-10-01", lines: [], intent: "save" });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["due_date", "lines"]));
  });

  it("builds the jsonb for save_invoice_draft: decimals, no blank lines, reimbursements at 0%", () => {
    const v = SaveInvoiceSchema.parse({
      client_id: CLIENT,
      issue_date: "2026-10-22",
      due_date: "2026-11-06",
      intent: "submit",
      lines: [line({ rate: "12500.5" }), line({ description: "", rate: "" }), line({ description: "Courier", rate: "250", tax_rate: "18", is_reimbursement: true })],
    });
    const p = draftPayload(v);
    expect(p.submit).toBe(true);
    const lines = p.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0].rate).toBe("12500.50");
    expect(lines[1].tax_rate).toBe("0");
    expect(p.place_of_supply_code).toBeNull();
  });
});

describe("Add from engagement, time and tasks (§7.9.2)", () => {
  it("bills an engagement's agreed fee for a period", () => {
    const l = engagementLine({ id: SERVICE, service_type: "gst", custom_name: null, frequency: "monthly", billing_frequency: null, agreed_fee: "3500", sac_code: null, is_active: true }, "Sep 2026", "998231");
    expect(l.rate).toBe("3500.00");
    expect(l.client_service_id).toBe(SERVICE);
    expect(l.sac_code).toBe("998231");
    expect(l.description).toContain("Sep 2026");
  });

  it("offers months, quarters or years by billing frequency", () => {
    expect(periodChoices("monthly", "2026-10-23")[0]).toMatch(/Oct 2026/);
    expect(periodChoices("monthly", "2026-10-23")).toHaveLength(6);
    expect(periodChoices("annual", "2026-10-23")).toEqual(["FY 2026-27", "FY 2025-26"]);
  });

  it("groups unbilled time by task at each person's value and leaves unrated entries out", () => {
    const entries: UnbilledEntry[] = [
      { id: ENTRY_1, task_id: TASK, task_number: "T-1", task_title: "GSTR-3B Sep", employee_name: "Asha", started_at: "2026-10-01T10:00:00Z", minutes: 90, billing_rate_per_hour: 1000, amount: 1500 },
      { id: ENTRY_2, task_id: TASK, task_number: "T-1", task_title: "GSTR-3B Sep", employee_name: "Ravi", started_at: "2026-10-02T10:00:00Z", minutes: 30, billing_rate_per_hour: 800, amount: 400 },
      { id: ENTRY_3, task_id: null, task_number: null, task_title: null, employee_name: "Ravi", started_at: "2026-10-03T10:00:00Z", minutes: 45, billing_rate_per_hour: null, amount: null },
    ];
    const { lines, unrated } = unbilledTimeLines(entries, { sac: "998231" });
    expect(lines).toHaveLength(1);
    expect(lines[0].rate).toBe("1900.00");
    expect(lines[0].time_entry_ids).toEqual([ENTRY_1, ENTRY_2]);
    expect(lines[0].source_task_id).toBe(TASK);
    expect(lines[0].description).toContain("2 h");
    expect(unrated.map((u) => u.id)).toEqual([ENTRY_3]);
    expect(hoursLabel(45)).toBe("45 min");
    expect(hoursLabel(120)).toBe("2 h");
  });

  it("takes the SAC from the firm's map, else the default", () => {
    expect(sacForService("audit", { audit: "998221" }, "9982")).toBe("998221");
    expect(sacForService("audit", { audit: "12" }, "9982")).toBe("9982");
    expect(sacForService(null, {}, "")).toBe("9982");
  });
});

describe("Checks the editor shows (§7.9.2)", () => {
  it("notes an engagement line invoiced at a different amount from the agreed fee", () => {
    const notes = agreedFeeNotes([line({ client_service_id: SERVICE, rate: "3000", quantity: "1" })], [{ id: SERVICE, agreed_fee: 3500, service_type: "gst", custom_name: null }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("₹3,500.00");
    expect(notes[0]).toContain("₹3,000.00");
    expect(agreedFeeNotes([line({ client_service_id: SERVICE, rate: "1750", quantity: "2" })], [{ id: SERVICE, agreed_fee: 3500, service_type: "gst", custom_name: null }])).toEqual([]);
  });

  it("warns under Rule 47 only when the work is more than 30 days old", () => {
    expect(workRule47Warning({ periodLabel: "Sep 2026", invoiceDate: "2026-10-15" })).toBeNull();
    const late = workRule47Warning({ periodLabel: "Jul 2026", taskCompletionDates: ["2026-08-31"], invoiceDate: "2026-10-15" });
    expect(late?.level).toBe("late");
    expect(late?.message).toContain("Rule 47");
  });

  it("finds the invoice that already bills the engagement for the period, ignoring itself", () => {
    const billed = [{ client_service_id: SERVICE, billing_period_label: "Sep 2026", invoice_id: "inv-1", invoice_number: "TW/26-27/0042" }];
    const form = { id: null, billing_period_label: "sep  2026", lines: [{ client_service_id: SERVICE }] };
    expect(duplicatePeriodOnForm(form, billed)?.invoice_number).toBe("TW/26-27/0042");
    expect(duplicatePeriodOnForm({ ...form, id: "inv-1" }, billed)).toBeNull();
    expect(duplicatePeriodOnForm({ ...form, billing_period_label: "Oct 2026" }, billed)).toBeNull();
  });
});

describe("The list (§7.9.1)", () => {
  it("reads the FY: explicit wins, open-money links show every year, otherwise the top bar's FY", () => {
    expect(listFinancialYear("all", undefined, "2026-27")).toBeNull();
    expect(listFinancialYear("2025-26", ["overdue"], "2026-27")).toBe("2025-26");
    expect(listFinancialYear(null, ["sent", "partially_paid", "disputed"], "2026-27")).toBeNull();
    expect(listFinancialYear(null, ["awaiting_approval"], "2026-27")).toBeNull();
    expect(listFinancialYear(null, ["paid"], "2026-27")).toBe("2026-27");
    expect(listFinancialYear("junk", undefined, "2026-27")).toBe("2026-27");
  });

  it("turns date presets into FY-quarter ranges", () => {
    expect(datePresetRange("this_month", "2026-10-23")).toEqual({ from: "2026-10-01", to: "2026-10-23" });
    expect(datePresetRange("last_month", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(datePresetRange("this_quarter", "2026-10-23")).toEqual({ from: "2026-10-01", to: "2026-10-23" });
    expect(datePresetRange("last_quarter", "2026-10-23")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(datePresetRange("this_quarter", "2027-02-10")).toEqual({ from: "2027-01-01", to: "2027-02-10" });
    expect(datePresetRange("last_90_days", "2026-10-23")).toEqual({ from: "2026-07-26", to: "2026-10-23" });
  });

  it("names how an invoice was sent", () => {
    expect(sentViaLabel(["email", "whatsapp", "unknown"])).toBe("Email · WhatsApp");
    expect(sentViaLabel([])).toBeNull();
  });
});

describe("Lifecycle actions by state and role (§4.1, §7.9.3)", () => {
  const base: InvoiceActionState = {
    status: "draft",
    cancelled: false,
    invoiceKind: "tax_invoice",
    requiresApproval: false,
    approved: false,
    outstandingPaise: 0,
    reported: false,
    hasLiveReceipts: false,
    hasCreditNotes: false,
    hasDebitNotes: false,
  };

  it("lets a draft be edited, deleted and issued", () => {
    const a = invoiceActions(base, "manager");
    expect(a.edit && a.deleteDraft && a.issue).toBe(true);
    expect(a.recordReceipt || a.creditNote || a.cancelReissue).toBe(false);
  });

  it("holds a Manager's invoice over the limit until a Partner approves it (§18.3 Partner 5)", () => {
    const gated = { ...base, requiresApproval: true };
    expect(invoiceActions(gated, "manager").issue).toBe(false);
    expect(invoiceActions(gated, "manager").submitForApproval).toBe(true);
    expect(invoiceActions({ ...gated, approved: true }, "manager").issue).toBe(true);
    const waiting = invoiceActions({ ...gated, status: "awaiting_approval" }, "partner");
    expect(waiting.approve && waiting.returnToRaiser).toBe(true);
    expect(invoiceActions({ ...gated, status: "awaiting_approval" }, "manager").approve).toBe(false);
  });

  it("offers receipts, disputes and corrections on a sent invoice; credit notes and waivers to Partners only", () => {
    const sent = { ...base, status: "sent" as const, outstandingPaise: 118_000 };
    const m = invoiceActions(sent, "manager");
    const p = invoiceActions(sent, "partner");
    expect(m.edit).toBe(false);
    expect(m.recordReceipt && m.dispute && m.debitNote && m.cancelReissue && m.sendAgain).toBe(true);
    expect(m.creditNote || m.waive).toBe(false);
    expect(p.creditNote && p.waive).toBe(true);
  });

  it("blocks cancel and reissue once the month is in GSTR-1, or with payments or notes against it", () => {
    const sent = { ...base, status: "sent" as const, outstandingPaise: 100 };
    expect(invoiceActions({ ...sent, reported: true }, "partner").cancelReissueBlocked).toContain("GSTR-1");
    expect(invoiceActions({ ...sent, hasLiveReceipts: true }, "partner").cancelReissueBlocked).toContain("Reverse");
    expect(invoiceActions({ ...sent, hasCreditNotes: true }, "partner").cancelReissue).toBe(false);
    expect(invoiceActions({ ...sent, hasDebitNotes: true }, "partner").cancelReissue).toBe(false);
  });

  it("offers nothing to pay on a paid, waived or cancelled invoice", () => {
    expect(invoiceActions({ ...base, status: "paid" }, "partner").recordReceipt).toBe(false);
    const waived = invoiceActions({ ...base, status: "waived" }, "partner");
    expect(waived.sendAgain || waived.creditNote || waived.cancelReissue).toBe(false);
    const cancelled = invoiceActions({ ...base, status: "sent", cancelled: true, outstandingPaise: 100 }, "partner");
    expect(Object.entries(cancelled).filter(([k, v]) => k !== "cancelReissueBlocked" && v === true)).toEqual([]);
  });

  it("resolves a dispute; a debit note can't take another debit note", () => {
    expect(invoiceActions({ ...base, status: "disputed", outstandingPaise: 10 }, "manager").resolveDispute).toBe(true);
    expect(invoiceActions({ ...base, status: "sent", invoiceKind: "debit_note" }, "manager").debitNote).toBe(false);
  });

  it("reads the last reported GSTR-1 month", () => {
    expect(isReportedInGstr1("2026-09-30", "2026-09")).toBe(true);
    expect(isReportedInGstr1("2026-10-01", "2026-09")).toBe(false);
    expect(isReportedInGstr1("2026-10-01", null)).toBe(false);
    expect(isReportedInGstr1("2026-10-01", "Sep 2026")).toBe(false);
  });
});

describe("Export of the current view (§3.4, §11)", () => {
  const row: InvoiceExportRow = {
    invoice_number: "TW/26-27/0042",
    invoice_kind: "tax_invoice",
    issue_date: "2026-10-01",
    due_date: "2026-10-16",
    client_code: "TW-C-0007",
    client_name: "=Sharma, Traders",
    billing_period_label: "Sep 2026",
    taxable_amount: 10000,
    cgst_amount: 900,
    sgst_amount: 900,
    igst_amount: 0,
    reimbursement_amount: 0,
    round_off: 0,
    total_amount: 11800,
    amount_received: 5000,
    tds_credited: 1000,
    credit_noted: 0,
    outstanding_amount: 5800,
    status: "partially_paid",
    display_status: "overdue",
    sent_channels: ["email"],
    created_by_name: "Asha Rao",
  };

  it("writes amounts as two-place decimals and the derived status", () => {
    const t = invoiceExportTable([row, { ...row, invoice_number: null, status: "draft", display_status: "draft" }]);
    expect(t.header).toHaveLength(t.rows[0].length);
    expect(t.rows[0]).toContain("11800.00");
    expect(t.rows[0]).toContain("Overdue");
    expect(t.rows[0]).toContain("Email");
    expect(t.rows[1][0]).toBe("Draft");
    expect(t.rows[1][17]).toBe("");
    expect(INVOICE_EXPORT_MAX_ROWS).toBe(5000);
  });

  it("starts with a BOM, quotes commas and defuses formula-like cells", () => {
    const csv = toCsv(["Client", "Amount"], [["=Sharma, Traders", "-12.50"], ['He said "hi"', "+cmd"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"'=Sharma, Traders"`);
    expect(csv).toContain(",-12.50");
    expect(csv).toContain(`"He said ""hi"""`);
    expect(csv).toContain(",'+cmd");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("The WhatsApp message with the invoice (§7.13.2)", () => {
  const input = {
    contactName: "Rakesh Sharma",
    invoiceNumber: "TW/26-27/0042",
    periodLabel: "Sep 2026",
    totalPaise: 1_180_000,
    duePaise: 1_180_000,
    dueDate: "2026-11-06",
    portalUrl: "https://app.twchartered.com/portal/invoices/abc",
    upiUrl: "upi://pay?pa=taxwise@icici&pn=TaxWise&am=11800.00&cu=INR",
    firmName: "TaxWise Consultants",
  };

  it("puts the amount, due date, portal link and UPI link in the draft", () => {
    const s = invoiceShareText(input);
    expect(s).toContain("Hi Rakesh");
    expect(s).toContain("invoice TW/26-27/0042 for Sep 2026");
    expect(s).toContain("₹11,800.00");
    expect(s).toContain("06 Nov 2026");
    expect(s).toContain(input.portalUrl);
    expect(s).toContain(input.upiUrl);
  });

  it("says what is still to pay on a part-paid invoice", () => {
    expect(invoiceShareText({ ...input, duePaise: 580_000 })).toContain("₹5,800.00 still to pay");
  });

  it("greets without a name and leaves out what isn't there", () => {
    const s = invoiceShareText({ ...input, contactName: null, upiUrl: null, periodLabel: null });
    expect(s.startsWith("Hello,")).toBe(true);
    expect(s).not.toContain("UPI");
    expect(s).not.toContain(" for Sep 2026");
  });
});
