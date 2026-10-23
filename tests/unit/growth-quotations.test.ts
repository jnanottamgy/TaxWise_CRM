import { describe, expect, it } from "vitest";
import { amountInWords } from "@/lib/domain/money";
import {
  QuotationDraftSchema,
  QuotationLineSchema,
  RespondSchema,
  ApprovalDecisionSchema,
  SendQuotationEmailSchema,
  contingentFeeProblem,
  defaultValidUntil,
  derivedPlaceOfSupply,
  dueFollowUp,
  emailTypeLabel,
  emptyQuotationValues,
  followUpStatusInfo,
  followUpTone,
  followUpWhatsApp,
  halfRateLabel,
  isQuotationToken,
  isSavableLine,
  newLine,
  publicState,
  quotationActions,
  quotationDisplayStatus,
  quotationTotals,
  sendStatusInfo,
  totalRows,
  type QuotationActionInput,
  type QuotationDraftValues,
} from "@/lib/schemas/quotations";
import { newBuilderValues } from "@/components/quotations/builder/builder-initial";

/**
 * Quotations (§7.5.2 builder, §7.5.3 sending, tracking and follow-ups, §7.23 the client's link):
 * the totals and the tax split (to the paisa, the same rounding quotation_items_guard applies), what
 * a quotation offers whom, what the link shows, which follow-up is due, and the builder's schema.
 */

const VALID_GSTIN_KA = "29AABCS1234C1ZT";
const VALID_GSTIN_MH = "27AABCB1234C1ZE";

// Three lines: an odd-paise 18% line, a 5% line that rounds up, and a tiny line whose GST splits unevenly.
const LINES = [
  { quantity: "2", unit_price: "12345.67", tax_rate: "18" },
  { quantity: "1", unit_price: "999.99", tax_rate: "5" },
  { quantity: "1", unit_price: "10.05", tax_rate: "18" },
];

describe("quotationTotals (§7.5.2 totals, §6.4 the split)", () => {
  it("adds up an intra-state quotation line by line, half-up to the paisa, CGST taking the odd paisa", () => {
    const t = quotationTotals(LINES, "29", "29");
    expect(t.intraState).toBe(true);
    expect(t.lines.map((l) => [l.amountPaise, l.taxPaise])).toEqual([
      [2469134, 444444],
      [99999, 5000],
      [1005, 181],
    ]);
    expect(t.lines[2]).toMatchObject({ cgstPaise: 91, sgstPaise: 90, igstPaise: 0 });
    expect(t.subtotalPaise).toBe(2570138);
    expect(t.cgstPaise).toBe(224813);
    expect(t.sgstPaise).toBe(224812);
    expect(t.igstPaise).toBe(0);
    expect(t.taxPaise).toBe(449625);
    expect(t.totalPaise).toBe(3019763);
    expect(t.words).toBe(amountInWords(3019763));
    expect(t.words).toMatch(/Thirty Thousand One Hundred Ninety[- ]Seven/);
    expect(t.bands.map((b) => [b.rate, b.taxablePaise, b.cgstPaise, b.sgstPaise])).toEqual([
      [18, 2470139, 222313, 222312],
      [5, 99999, 2500, 2500],
    ]);
  });

  it("puts all the tax in IGST for another state", () => {
    const t = quotationTotals(LINES, "27", "29");
    expect(t.intraState).toBe(false);
    expect(t.cgstPaise + t.sgstPaise).toBe(0);
    expect(t.igstPaise).toBe(449625);
    expect(t.totalPaise).toBe(3019763);
    expect(totalRows(t).map((r) => r.label)).toEqual(["Subtotal", "IGST @ 18%", "IGST @ 5%", "Total"]);
  });

  it("lists CGST and SGST per rate, and a zero row when every line is exempt", () => {
    expect(totalRows(quotationTotals(LINES, "29", "29")).map((r) => r.label)).toEqual(["Subtotal", "CGST @ 9%", "SGST @ 9%", "CGST @ 2.5%", "SGST @ 2.5%", "Total"]);
    const exempt = quotationTotals([{ quantity: "1", unit_price: "5000", tax_rate: "0" }], "29", "29");
    expect(totalRows(exempt)).toEqual([
      { label: "Subtotal", paise: 500000 },
      { label: "CGST + SGST", paise: 0 },
      { label: "Total", paise: 500000, emphasis: true },
    ]);
  });

  it("counts a line that doesn't parse yet as zero, and fractional quantities exactly", () => {
    const t = quotationTotals(
      [
        { quantity: "", unit_price: "abc", tax_rate: "18" },
        { quantity: "1.5", unit_price: "1,000", tax_rate: "18" },
      ],
      "29",
      "29",
    );
    expect(t.lines[0].totalPaise).toBe(0);
    expect(t.lines[1]).toMatchObject({ amountPaise: 150000, taxPaise: 27000 });
    expect(t.totalPaise).toBe(177000);
  });

  it("labels half rates", () => {
    expect(halfRateLabel(18)).toBe("9%");
    expect(halfRateLabel(5)).toBe("2.5%");
    expect(halfRateLabel(40)).toBe("20%");
  });
});

describe("contingent fees (§6.8, CA Act First Schedule Part I clause 10)", () => {
  it.each([
    "Success fee of 10% on the refund",
    "Performance-based fee for the appeal",
    "20% of the tax saved",
    "Fee contingent on the outcome of the assessment",
    "Professional fee depending on the result of the refund claim",
  ])("refuses %s", (d) => {
    expect(contingentFeeProblem(d)).toMatch(/isn't allowed for a CA in practice/);
  });

  it.each(["GST compliance: GSTR-1, GSTR-3B and reconciliation", "Income tax return preparation and filing", "Representation before the assessing officer, fixed fee"])("allows %s", (d) => {
    expect(contingentFeeProblem(d)).toBeNull();
  });
});

describe("the builder's schema (§7.5.2)", () => {
  const base = (over: Partial<QuotationDraftValues> = {}): QuotationDraftValues => ({
    ...emptyQuotationValues({ today: "2026-10-23", validityDays: 30, terms: "Fees are exclusive of GST.", firmStateCode: "29" }),
    client_name: "Ravi Sharma",
    client_email: "ravi@sharmatraders.in",
    lines: [newLine({ description: "GST compliance: GSTR-1, GSTR-3B and reconciliation", unit_price: "1,25,000" })],
    ...over,
  });

  it("starts today, valid for the Settings days, with the Settings terms, one 18% line and the firm's state", () => {
    const v = emptyQuotationValues({ today: "2026-10-23", validityDays: 30, terms: "T", firmStateCode: "29" });
    expect(v).toMatchObject({ issue_date: "2026-10-23", valid_until: "2026-11-22", terms: "T", place_of_supply_code: "29", party: "other" });
    expect(v.lines).toHaveLength(1);
    expect(v.lines?.[0]).toMatchObject({ quantity: "1", tax_rate: "18" });
    expect(defaultValidUntil("2026-10-23", 30)).toBe("2026-11-22");
  });

  it("parses a complete draft, money in rupees with two decimals", () => {
    const r = QuotationDraftSchema.safeParse(base());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines[0]).toMatchObject({ unit_price: "125000.00", quantity: "1", tax_rate: "18", service_type: null });
  });

  it("requires the name, a valid email and a date order", () => {
    const r = QuotationDraftSchema.safeParse(base({ client_name: "", client_email: "ravi@", valid_until: "2026-10-01" }));
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["client_name", "client_email"]));
    const order = QuotationDraftSchema.safeParse(base({ valid_until: "2026-10-01" }));
    expect(order.success ? [] : order.error.issues.map((i) => i.message)).toContain("Valid until can't be before the issue date.");
  });

  it("checks the GSTIN and holds the place of supply to its state", () => {
    expect(QuotationDraftSchema.safeParse(base({ client_gstin: "29AABCS1234C1Z5" })).success).toBe(false);
    const mismatch = QuotationDraftSchema.safeParse(base({ client_gstin: VALID_GSTIN_MH, place_of_supply_code: "29" }));
    expect(mismatch.success ? [] : mismatch.error.issues.map((i) => i.path.join("."))).toContain("place_of_supply_code");
    expect(QuotationDraftSchema.safeParse(base({ client_gstin: VALID_GSTIN_MH.toLowerCase(), place_of_supply_code: "27" })).success).toBe(true);
  });

  it("needs the lead or client chosen when quoting for one", () => {
    const r = QuotationDraftSchema.safeParse(base({ party: "lead", lead_id: null }));
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join("."))).toContain("lead_id");
  });

  it("validates each line: description, a quantity above zero, a price and a listed GST rate", () => {
    expect(QuotationLineSchema.safeParse(newLine({ description: "Audit", unit_price: "50000", quantity: "0" })).success).toBe(false);
    expect(QuotationLineSchema.safeParse(newLine({ description: "Audit", unit_price: "" })).success).toBe(false);
    expect(QuotationLineSchema.safeParse(newLine({ description: "Audit", unit_price: "50000", tax_rate: "12" as never })).success).toBe(false);
    const fee = QuotationLineSchema.safeParse(newLine({ description: "Success fee on the refund", unit_price: "5000" }));
    expect(fee.success ? [] : fee.error.issues.map((i) => i.path.join("."))).toContain("description");
    expect(isSavableLine(newLine({ description: "Audit", unit_price: "50000" }))).toBe(true);
    expect(isSavableLine(newLine({ description: "Audit" }))).toBe(false);
  });

  it("derives the place of supply from a valid GSTIN and locks it", () => {
    expect(derivedPlaceOfSupply(VALID_GSTIN_MH, "29", "29")).toEqual({ code: "27", locked: true });
    expect(derivedPlaceOfSupply("27AAAAA0000A1Z0", "33", "29")).toEqual({ code: "33", locked: false });
    expect(derivedPlaceOfSupply("", "", "29")).toEqual({ code: "29", locked: false });
  });

  it("pre-fills from a lead: who it's for and a line per service asked for", () => {
    const v = newBuilderValues(
      { today: "2026-10-23", validityDays: 15, terms: "T", firmStateCode: "29", approvalLimitPaise: null },
      {
        party: "lead",
        lead_id: "4b0f5a8e-2c1d-4e3f-9a7b-6c5d4e3f2a1b",
        client_id: null,
        label: "LD-0012 · Sharma Traders · Ravi Sharma",
        client_name: "Ravi Sharma",
        client_email: "ravi@sharmatraders.in",
        client_phone: "9876543210",
        client_company: "Sharma Traders",
        client_gstin: VALID_GSTIN_KA,
        state_code: null,
        services: ["gst", "income_tax"],
      },
    );
    expect(v).toMatchObject({ party: "lead", client_company: "Sharma Traders", place_of_supply_code: "29", valid_until: "2026-11-07" });
    expect(v.lines?.map((l) => [l.service_type, l.description])).toEqual([
      ["gst", "GST compliance: GSTR-1, GSTR-3B and reconciliation"],
      ["income_tax", "Income tax return preparation and filing"],
    ]);
  });
});

describe("quotationActions (§7.5.2 approval, §7.5.3 send, revise, convert)", () => {
  const q = (over: Partial<QuotationActionInput> = {}): QuotationActionInput => ({
    status: "draft",
    validUntil: "2026-11-22",
    today: "2026-10-23",
    createdByRole: "manager",
    totalPaise: 5_900_000,
    limitPaise: 10_000_000,
    lineCount: 2,
    hasEmail: true,
    convertedClientId: null,
    clientId: null,
    deleted: false,
    ...over,
  });

  it("lets a Manager send a Draft within the limit, and edit it", () => {
    const a = quotationActions(q(), "manager");
    expect(a).toMatchObject({ edit: true, send: true, submitForApproval: false, needsApproval: false, revise: false, remove: true, sendBlockedReason: null });
  });

  it("sends a Manager's Draft over the limit for approval instead", () => {
    const a = quotationActions(q({ totalPaise: 11_800_000 }), "manager");
    expect(a.send).toBe(false);
    expect(a.submitForApproval).toBe(true);
    expect(a.sendBlockedReason).toMatch(/submit it for a Partner's approval/);
  });

  it("always needs approval when the limit is empty, never when it is zero, and never for a Partner's own", () => {
    expect(quotationActions(q({ limitPaise: null, totalPaise: 100 }), "manager").needsApproval).toBe(true);
    expect(quotationActions(q({ limitPaise: 0, totalPaise: 99_999_999 }), "manager").needsApproval).toBe(false);
    const partner = quotationActions(q({ createdByRole: "partner", totalPaise: 99_999_999 }), "partner");
    expect(partner).toMatchObject({ needsApproval: false, send: true, submitForApproval: false });
  });

  it("lets only a Partner decide a pending one; either can revise it", () => {
    const pending = q({ status: "pending_approval", totalPaise: 11_800_000 });
    expect(quotationActions(pending, "partner")).toMatchObject({ decideApproval: true, edit: false, revise: true, send: false });
    expect(quotationActions(pending, "manager")).toMatchObject({ decideApproval: false, revise: true });
  });

  it("sends an Approved one, even over the limit", () => {
    expect(quotationActions(q({ status: "approved", totalPaise: 11_800_000 }), "manager")).toMatchObject({ send: true, edit: false, revise: true });
  });

  it("explains why a Draft can't go: no lines, a passed date, no email", () => {
    expect(quotationActions(q({ lineCount: 0 }), "manager").sendBlockedReason).toBe("Add at least one line before sending it.");
    expect(quotationActions(q({ validUntil: "2026-10-22" }), "manager").sendBlockedReason).toMatch(/valid-until date has passed/);
    expect(quotationActions(q({ hasEmail: false }), "manager").sendBlockedReason).toMatch(/email address/);
  });

  it("resends and follows up a Sent or Viewed one while it is in date; after that, only revise", () => {
    expect(quotationActions(q({ status: "viewed" }), "manager")).toMatchObject({ resend: true, followUp: true, revise: true, edit: false, send: false });
    expect(quotationActions(q({ status: "sent", validUntil: "2026-10-22" }), "manager")).toMatchObject({ resend: false, followUp: false, revise: true });
  });

  it("offers Create client once on an accepted quotation, and never deletes it", () => {
    expect(quotationActions(q({ status: "accepted" }), "manager")).toMatchObject({ createClient: true, remove: false, revise: false });
    expect(quotationActions(q({ status: "accepted", convertedClientId: "c" }), "manager").createClient).toBe(false);
    expect(quotationActions(q({ status: "accepted", clientId: "c" }), "manager").createClient).toBe(false);
    expect(quotationActions(q({ status: "superseded" }), "manager")).toMatchObject({ revise: false, remove: true });
    expect(quotationActions(q({ deleted: true }), "manager")).toMatchObject({ edit: false, send: false, remove: false });
  });

  it("shows Sent or Viewed past the date as Expired before the nightly run", () => {
    expect(quotationDisplayStatus("sent", "2026-10-22", "2026-10-23")).toBe("expired");
    expect(quotationDisplayStatus("viewed", "2026-10-23", "2026-10-23")).toBe("viewed");
    expect(quotationDisplayStatus("accepted", "2026-10-01", "2026-10-23")).toBe("accepted");
  });
});

describe("the client's link (§7.23)", () => {
  const row = (over: Partial<Parameters<typeof publicState>[0]> = {}) => ({ status: "sent" as const, valid_until: "2026-11-22", responded_at: null, accepted_by_name: null, deleted_at: null, ...over });

  it("is open while Sent or Viewed and in date", () => {
    expect(publicState(row(), "2026-10-23")).toEqual({ kind: "open" });
    expect(publicState(row({ status: "viewed" }), "2026-11-22")).toEqual({ kind: "open" });
  });

  it("says why it can't be answered otherwise", () => {
    expect(publicState(row({ valid_until: "2026-10-22" }), "2026-10-23")).toEqual({ kind: "expired" });
    expect(publicState(row({ status: "expired" }), "2026-10-23")).toEqual({ kind: "expired" });
    expect(publicState(row({ status: "superseded" }), "2026-10-23")).toEqual({ kind: "superseded" });
    expect(publicState(row({ status: "accepted", responded_at: "2026-10-20T10:00:00Z", accepted_by_name: "Ravi Sharma" }), "2026-10-23")).toEqual({
      kind: "accepted",
      respondedAt: "2026-10-20T10:00:00Z",
      acceptedByName: "Ravi Sharma",
    });
    expect(publicState(row({ status: "rejected", responded_at: "2026-10-20T10:00:00Z" }), "2026-10-23")).toMatchObject({ kind: "declined" });
    expect(publicState(row({ status: "draft" }), "2026-10-23")).toEqual({ kind: "unavailable" });
    expect(publicState(row({ deleted_at: "2026-10-21T00:00:00Z" }), "2026-10-23")).toEqual({ kind: "unavailable" });
  });

  it("takes a typed full name to accept and a reason to decline", () => {
    expect(RespondSchema.safeParse({ response: "accept", name: "Ravi Sharma" }).success).toBe(true);
    expect(RespondSchema.safeParse({ response: "accept", name: "R" }).success).toBe(false);
    expect(RespondSchema.safeParse({ response: "accept", name: "1234" }).success).toBe(false);
    expect(RespondSchema.safeParse({ response: "decline", reason: "no" }).success).toBe(false);
    expect(RespondSchema.safeParse({ response: "decline", reason: "Went with our existing CA" }).success).toBe(true);
  });

  it("only looks up token-shaped links", () => {
    expect(isQuotationToken("Qm9vNXJmZ3B1a2hzZ3V5dmJ5cGh6d2xrbXF2Y2Rhbm8")).toBe(true);
    expect(isQuotationToken("abc")).toBe(false);
    expect(isQuotationToken("Qm9vNXJmZ3B1a2hzZ3V5dmJ5cGh6d2xrbXF2Y2Rhbm8/")).toBe(false);
    expect(isQuotationToken(null)).toBe(false);
  });
});

describe("follow-ups (§7.5.3 day 3, 7 and 14)", () => {
  const now = new Date("2026-10-23T09:00:00Z");
  const rows = [
    { id: "a", follow_up_day: 3, scheduled_at: "2026-10-12T18:30:00Z", status: "pending" },
    { id: "b", follow_up_day: 7, scheduled_at: "2026-10-16T18:30:00Z", status: "pending" },
    { id: "c", follow_up_day: 14, scheduled_at: "2026-10-23T18:30:00Z", status: "pending" },
  ];

  it("sends the latest one due and skips the earlier one it replaces", () => {
    const d = dueFollowUp(rows, now);
    expect(d?.due.id).toBe("b");
    expect(d?.skip.map((r) => r.id)).toEqual(["a"]);
    expect(dueFollowUp(rows.map((r) => ({ ...r, status: r.id === "c" ? "pending" : "sent" })), now)).toBeNull();
  });

  it("uses the 3 / 7 / 14 tone for other configured days", () => {
    expect([1, 3, 5, 7, 10, 14, 30].map(followUpTone)).toEqual([3, 3, 3, 7, 7, 14, 14]);
  });

  it("says what each follow-up is doing", () => {
    expect(followUpStatusInfo({ status: "pending", scheduled_at: "2026-10-24T08:00:00Z" }, now, true).label).toBe("Scheduled");
    expect(followUpStatusInfo({ status: "pending", scheduled_at: "2026-10-20T08:00:00Z" }, now, true)).toMatchObject({ label: "Due", tone: "warning" });
    expect(followUpStatusInfo({ status: "failed", scheduled_at: "2026-10-20T08:00:00Z" }, now, true)).toMatchObject({ label: "Failed", tone: "danger" });
    expect(followUpStatusInfo({ status: "pending", scheduled_at: "2026-10-20T08:00:00Z" }, now, false).label).toBe("Not sent");
    expect(followUpStatusInfo({ status: "handed_off", scheduled_at: "2026-10-20T08:00:00Z" }, now, true).label).toBe("Handed off");
  });

  it("drafts a WhatsApp follow-up with the link, shorter each time", () => {
    const d = { firstName: "Ravi", number: "TW-Q/26-27/0007", amount: "₹30,197.63", validUntil: "22 Nov 2026", sentOn: "20 Oct 2026", link: "https://app.twchartered.com/q/abc" };
    const three = followUpWhatsApp({ ...d, day: 3 });
    const seven = followUpWhatsApp({ ...d, day: 7 });
    const fourteen = followUpWhatsApp({ ...d, day: 14 });
    expect(three).toMatch(/^Hi Ravi, following up on our quotation TW-Q\/26-27\/0007, sent on 20 Oct 2026/);
    expect(seven).toContain("₹30,197.63");
    for (const t of [three, seven, fourteen]) expect(t).toContain(d.link);
    expect(fourteen.length).toBeLessThan(seven.length);
    expect(seven.length).toBeLessThan(three.length);
  });

  it("never calls a hand-off delivered (§7.13.1)", () => {
    expect(sendStatusInfo("whatsapp_handoff", "handed_off").label).toBe("Handed off");
    expect(sendStatusInfo("gmail_handoff", "sent").label).toBe("Handed off");
    expect(sendStatusInfo("internal_note", "handed_off").label).toBe("Link copied");
    expect(sendStatusInfo("email", "opened")).toMatchObject({ label: "Opened", tone: "success" });
    expect(sendStatusInfo("email", "bounced")).toMatchObject({ label: "Bounced", tone: "danger" });
    expect(emailTypeLabel("follow_up_21")).toBe("Follow-up, day 21");
    expect(emailTypeLabel("revision")).toBe("Revised quotation");
  });
});

describe("action inputs", () => {
  const id = "4b0f5a8e-2c1d-4e3f-9a7b-6c5d4e3f2a1b";
  it("needs comments to return a quotation, not to approve it", () => {
    expect(ApprovalDecisionSchema.safeParse({ id, updatedAt: "2026-10-23T00:00:00Z", decision: "approve" }).success).toBe(true);
    expect(ApprovalDecisionSchema.safeParse({ id, updatedAt: "2026-10-23T00:00:00Z", decision: "return", note: "" }).success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse({ id, updatedAt: "2026-10-23T00:00:00Z", decision: "return", note: "Split the audit fee by quarter." }).success).toBe(true);
  });

  it("checks every Cc address", () => {
    expect(SendQuotationEmailSchema.safeParse({ id, updatedAt: "x", to: "ravi@sharmatraders.in", cc: "a@b.in, c@d.in" }).success).toBe(true);
    expect(SendQuotationEmailSchema.safeParse({ id, updatedAt: "x", to: "ravi@sharmatraders.in", cc: "a@b.in, nope" }).success).toBe(false);
  });
});
