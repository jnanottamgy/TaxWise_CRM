import { describe, expect, it } from "vitest";
import { gstDocRow } from "@/lib/domain/gstr2b";
import { formatINR } from "@/lib/domain/money";
import {
  GSTR2B_PATH_PATTERN,
  ImsDecisionSchema,
  ResolveLinesSchema,
  compactDoc,
  defaultPeriod,
  defaultSupplierFollowUp,
  expandDoc,
  followUpLineText,
  isPeriod,
  openItemFromLine,
  periodChoices,
  periodFinancialYear,
  periodLabel,
  periodLongLabel,
  periodOf,
  periodSortKey,
  periodStart,
  readEntryData,
  readRunSummary,
  shiftPeriod,
  supplierMissingItems,
  type FollowUpLine,
} from "@/lib/schemas/gst-recon";

const RUN = "8f0e7c55-3a8f-4c38-9d1b-2f6a7c1d4e01";
const LINE = "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("periods (MMYYYY, §7.8.1)", () => {
  it("recognises MMYYYY only", () => {
    expect(isPeriod("092026")).toBe(true);
    expect(isPeriod("132026")).toBe(false);
    expect(isPeriod("002026")).toBe(false);
    expect(isPeriod("2026-09")).toBe(false);
    expect(isPeriod(92026)).toBe(false);
  });

  it("labels a month short and long", () => {
    expect(periodLabel("092026")).toBe("Sep 2026");
    expect(periodLongLabel("092026")).toBe("September 2026");
    expect(periodLongLabel("not a period")).toBe("not a period");
    expect(periodLabel(null)).toBe("");
  });

  it("gives the first day and the month of a date", () => {
    expect(periodStart("022027")).toBe("2027-02-01");
    expect(periodOf("2026-09-18")).toBe("092026");
    expect(() => periodStart("2026")).toThrow();
  });

  it("shifts across year ends both ways", () => {
    expect(shiftPeriod("122026", 1)).toBe("012027");
    expect(shiftPeriod("012027", -1)).toBe("122026");
    expect(shiftPeriod("032026", -15)).toBe("122024");
    expect(shiftPeriod("092026", 0)).toBe("092026");
  });

  it("puts April–March in one financial year (§0.1 rule 13)", () => {
    expect(periodFinancialYear("042026")).toBe("2026-27");
    expect(periodFinancialYear("032027")).toBe("2026-27");
    expect(periodFinancialYear("032026")).toBe("2025-26");
  });

  it("sorts months as text by year first", () => {
    const months = ["012027", "122026", "092026"];
    expect([...months].sort((a, b) => periodSortKey(a).localeCompare(periodSortKey(b)))).toEqual(["092026", "122026", "012027"]);
  });

  it("defaults to last month and offers this month back two years", () => {
    expect(defaultPeriod("2026-10-24")).toBe("092026");
    expect(defaultPeriod("2027-01-05")).toBe("122026");
    const choices = periodChoices("2026-10-24");
    expect(choices).toHaveLength(25);
    expect(choices[0]).toEqual({ value: "102026", label: "October 2026" });
    expect(choices[24].value).toBe("102024");
  });
});

describe("stored documents", () => {
  const full = gstDocRow({
    section: "b2b",
    supplierGstin: "27AAPFU0939F1ZV",
    supplierName: "Mehta Traders",
    docType: "invoice",
    docNumber: "MT/245",
    docDate: "2026-09-12",
    taxable: 1_00_000_00,
    cgst: 9_000_00,
    sgst: 9_000_00,
    ref: "b2b:27AAPFU0939F1ZV:MT/245",
    itcAvailable: true,
    supplierPeriod: "092026",
  });

  it("round-trips through the compact form", () => {
    expect(expandDoc(compactDoc(full))).toEqual(full);
  });

  it("leaves defaults out of the compact form", () => {
    const plain = gstDocRow({ supplierGstin: "27AAPFU0939F1ZV", docNumber: "7", taxable: 500_00 });
    const c = compactDoc(plain);
    expect(c).not.toHaveProperty("supplierName");
    expect(c).not.toHaveProperty("reverseCharge");
    expect(c).not.toHaveProperty("portCode");
    expect(expandDoc(c)).toEqual(plain);
  });

  it("reads anything that isn't a document as null, and repairs bad fields", () => {
    expect(expandDoc(null)).toBeNull();
    expect(expandDoc([1, 2])).toBeNull();
    const repaired = expandDoc({ section: "elsewhere", docType: "voucher", docNumber: "9", taxable: 12.5, docDate: "12/09/2026" });
    expect(repaired?.section).toBe("register");
    expect(repaired?.docType).toBe("invoice");
    expect(repaired?.taxable).toBe(0);
    expect(repaired?.docDate).toBeNull();
  });
});

describe("readEntryData", () => {
  it("is tolerant of empty and partial rows", () => {
    const d = readEntryData(null);
    expect(d.portal).toBeNull();
    expect(d.books).toBeNull();
    expect(d.itc).toEqual({ portal: 0, books: 0 });
    expect(d.notes).toEqual([]);
    expect(d.cleared).toBeNull();
    expect(d.carried).toBeNull();
  });

  it("reads the cleared and carried markers", () => {
    const d = readEntryData({
      itc: { portal: 18_000_00, books: 18_000_00 },
      notes: ["Matched on the invoice number", 7],
      cleared: { firstSeenPeriod: "082026", message: "Reported in September", amountsAgree: true, tier: "loose" },
      carried: { monthsOpen: 2 },
    });
    expect(d.notes).toEqual(["Matched on the invoice number"]);
    expect(d.cleared).toEqual({ firstSeenPeriod: "082026", message: "Reported in September", amountsAgree: true, tier: "loose" });
    expect(d.carried).toEqual({ monthsOpen: 2 });
  });
});

describe("openItemFromLine (carry-forward, §6.12)", () => {
  const base = { entry_key: "k1", id: LINE, first_seen_period: "082026", supplier_gstin: "27AAPFU0939F1ZV", supplier_name: "Mehta Traders", data: { books: { docNumber: "MT/245", taxable: 100 } } };

  it("carries the three open buckets only", () => {
    expect(openItemFromLine({ ...base, bucket: "matched" }, "092026")).toBeNull();
    const item = openItemFromLine({ ...base, bucket: "missing_in_2b" }, "092026");
    expect(item?.key).toBe("k1");
    expect(item?.firstSeenPeriod).toBe("082026");
    expect(item?.books?.docNumber).toBe("MT/245");
  });

  it("falls back to the line id and the run's month", () => {
    const item = openItemFromLine({ ...base, entry_key: null, first_seen_period: null, bucket: "mismatch" }, "092026");
    expect(item?.key).toBe(LINE);
    expect(item?.firstSeenPeriod).toBe("092026");
  });
});

describe("readRunSummary", () => {
  it("reads a fixture row as zeros", () => {
    const s = readRunSummary({});
    expect(s.summary.buckets.matched).toEqual({ count: 0, portalItc: 0, booksItc: 0 });
    expect(s.summary.itc.atRisk).toBe(0);
    expect(s.suppliers).toEqual([]);
    expect(s.carryForward).toBeNull();
  });

  it("keeps the stored figures", () => {
    const s = readRunSummary({
      summary: { buckets: { mismatch: { count: 3, portalItc: 900, booksItc: 1200 } }, itc: { atRisk: 1200, unclaimed: 450 }, byTier: { exact: 10, loose: 2 } },
      gstr2b: { gstin: "27AAPFU0939F1ZV", period: "092026", documents: 12 },
      carryForward: { fromRunId: RUN, fromPeriod: "082026", cleared: 2, stillOpen: 1 },
    });
    expect(s.summary.buckets.mismatch.count).toBe(3);
    expect(s.summary.itc.unclaimed).toBe(450);
    expect(s.summary.byTier).toEqual({ exact: 10, loose: 2, fuzzy: 0 });
    expect(s.gstr2b.gstin).toBe("27AAPFU0939F1ZV");
    expect(s.carryForward).toEqual({ fromRunId: RUN, fromPeriod: "082026", cleared: 2, stillOpen: 1 });
  });
});

describe("supplier follow-up (§7.8.1)", () => {
  const missing: FollowUpLine = { bucket: "missing_in_2b", docType: "invoice", docNumber: "MT/245", docDate: "2026-09-12", taxable: 1_00_000_00, itcBooks: 18_000_00, itcPortal: 0 };
  const differs: FollowUpLine = { bucket: "mismatch", docType: "invoice", docNumber: "MT/250", docDate: null, taxable: 50_000_00, itcBooks: 9_000_00, itcPortal: 8_100_00 };

  it("names each document and its GST", () => {
    expect(followUpLineText(missing)).toContain("MT/245");
    expect(followUpLineText(missing)).toContain(formatINR(18_000_00));
    expect(followUpLineText(missing)).toContain("not in GSTR-2B");
    expect(followUpLineText(differs)).toContain(`our books show GST ${formatINR(9_000_00)}, GSTR-2B shows ${formatINR(8_100_00)}`);
  });

  it("lists the missing documents before the mismatched ones, under the supplier", () => {
    const text = supplierMissingItems({ name: "Mehta Traders", gstin: "27AAPFU0939F1ZV" }, [differs, missing]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Mehta Traders (GSTIN 27AAPFU0939F1ZV)");
    expect(lines[1]).toContain("MT/245");
    expect(lines[2]).toContain("MT/250");
  });

  it("keeps the WhatsApp draft short, with the period and the list", () => {
    const wa = defaultSupplierFollowUp({ contactName: "Ritu", periodText: "September 2026", missingItems: "Mehta Traders" });
    expect(wa.startsWith("Hi Ritu,")).toBe(true);
    expect(wa).toContain("Mehta Traders");
    expect(defaultSupplierFollowUp({ contactName: null, periodText: "September 2026", missingItems: "x" }).startsWith("Hi,")).toBe(true);
    expect(wa).not.toContain("Warm regards");
    expect(wa).toContain("September 2026");
  });
});

describe("schemas", () => {
  it("accepts only a GSTR-2B path inside the client's folder", () => {
    expect(GSTR2B_PATH_PATTERN.test(`${RUN}/gstr2b/${LINE}.json`)).toBe(true);
    expect(GSTR2B_PATH_PATTERN.test(`${RUN}/gstr2b/../${LINE}.json`)).toBe(false);
    expect(GSTR2B_PATH_PATTERN.test(`${RUN}/other/${LINE}.json`)).toBe(false);
  });

  it("needs a note to ignore lines", () => {
    const lines = [{ id: LINE, updatedAt: "2026-10-01T10:00:00.000Z" }];
    expect(ResolveLinesSchema.safeParse({ runId: RUN, lines, resolution: "ignore", note: "" }).success).toBe(false);
    expect(ResolveLinesSchema.safeParse({ runId: RUN, lines, resolution: "ignore", note: "Blocked credit under s.17(5)" }).success).toBe(true);
    expect(ResolveLinesSchema.safeParse({ runId: RUN, lines, resolution: "accepted" }).success).toBe(true);
    expect(ResolveLinesSchema.safeParse({ runId: RUN, lines: [], resolution: "accepted" }).success).toBe(false);
  });

  it("needs a reason for every IMS decision", () => {
    const base = { runId: RUN, lineId: LINE, updatedAt: "2026-10-01T10:00:00.000Z", action: "reject" };
    expect(ImsDecisionSchema.safeParse({ ...base, reason: "  " }).success).toBe(false);
    expect(ImsDecisionSchema.safeParse({ ...base, reason: "Goods returned" }).success).toBe(true);
  });
});
