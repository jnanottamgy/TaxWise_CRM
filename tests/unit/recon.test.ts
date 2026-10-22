import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gstDocRow, mapColumns, parseGstr2b, parseRegisterRows, type GstDocRow, type GstDocRowInput, type SheetRow } from "@/lib/domain/gstr2b";
import {
  amountDeltas,
  carryForward,
  checkPortalGstin,
  datesWithin,
  exactDocKey,
  headsWithinTolerance,
  IMS_DEEMED_ACCEPTANCE_NOTE,
  looseDocKey,
  matchDocuments,
  monthsBetweenPeriods,
  openItemsOf,
  RECON_DEFAULTS,
  RECON_EXPORT_HEADERS,
  reconcile,
  reconExportRows,
  supplierFollowUpItems,
  suppliersToChase,
  taxableWithinFuzzyTolerance,
  type ReconEntry,
  type ReconResult,
} from "@/lib/domain/recon";

const FIXTURES = join(__dirname, "..", "fixtures", "gstr2b");
const CLIENT = "29AAKCB1111F1Z3";
const KAVERI = "29AABCK1234A1Z5";
const MAHALAXMI = "27AACCM9012C1ZU";
const SHREE = "29AAFCS5678B1Z3";
const PRAKASH = "29AAAPZ2222G1ZQ";

const twoB = parseGstr2b(readFileSync(join(FIXTURES, "gstr2b-sep-2026.json"), "utf8"));
const registerFile = JSON.parse(readFileSync(join(FIXTURES, "purchase-register-sep-2026.json"), "utf8")) as { headers: string[]; rows: SheetRow[] };
const books = parseRegisterRows(registerFile.rows, mapColumns(registerFile.headers).mapping).rows;
const sep = reconcile(twoB.rows, books, { clientGstin: CLIENT, portalGstin: twoB.gstin });

const P = (input: Partial<GstDocRowInput> & { docNumber: string }): GstDocRow =>
  gstDocRow({ section: "b2b", supplierGstin: KAVERI, docDate: "2026-09-10", taxable: 1_000_000, cgst: 90_000, sgst: 90_000, ...input });
const B = (input: Partial<GstDocRowInput> & { docNumber: string }): GstDocRow =>
  gstDocRow({ section: "register", supplierGstin: KAVERI, docDate: "2026-09-10", taxable: 1_000_000, cgst: 90_000, sgst: 90_000, ...input });

function entryFor(result: ReconResult, docNumber: string): ReconEntry {
  const e = result.entries.find((x) => x.portal?.docNumber === docNumber || x.books?.docNumber === docNumber);
  if (!e) throw new Error(`no entry ${docNumber}`);
  return e;
}

// -------------------------------------------------------------------------------------------------
// Keys and tolerances (§6.12)
// -------------------------------------------------------------------------------------------------

describe("document-number keys", () => {
  it("exact: trimmed and upper-cased", () => {
    expect(exactDocKey("  inv/007 ")).toBe("INV/007");
    expect(exactDocKey("INV/007")).not.toBe(exactDocKey("inv-7"));
  });

  it("loose: alphanumeric only, numeric runs de-zero-padded ('INV/007' ≡ 'inv-7')", () => {
    expect(looseDocKey("INV/007")).toBe("INV7");
    expect(looseDocKey("inv-7")).toBe("INV7");
    expect(looseDocKey("2026/INV/0010")).toBe("2026INV10");
    expect(looseDocKey("INV-10-007")).toBe(looseDocKey("INV/10/7"));
    expect(looseDocKey("000")).toBe("0");
    expect(looseDocKey("A-1")).not.toBe(looseDocKey("A-10"));
    expect(looseDocKey("--/")).toBe("");
  });
});

describe("tolerances", () => {
  it("fuzzy taxable: within ±₹1 …", () => {
    expect(taxableWithinFuzzyTolerance(10_000, 10_100)).toBe(true);
    expect(taxableWithinFuzzyTolerance(10_000, 10_101)).toBe(false);
  });

  it("… or within 0.5% of the larger value (half-up to the paisa)", () => {
    expect(taxableWithinFuzzyTolerance(10_000_000, 10_050_000)).toBe(true); // ₹1,00,000 vs ₹1,00,500
    expect(taxableWithinFuzzyTolerance(10_000_000, 10_050_251)).toBe(true); // 0.5% of ₹1,00,502.51 = ₹502.51
    expect(taxableWithinFuzzyTolerance(10_000_000, 10_050_252)).toBe(false);
    expect(taxableWithinFuzzyTolerance(10_050_000, 10_000_000)).toBe(true); // symmetric
    expect(taxableWithinFuzzyTolerance(-10_000_000, -10_040_000)).toBe(true); // credit notes
  });

  it("takes the tolerances as parameters", () => {
    expect(taxableWithinFuzzyTolerance(10_000_000, 10_050_000, { fuzzyTaxableTolerancePaise: 100, fuzzyTaxablePercent: "0.1" })).toBe(false);
    expect(taxableWithinFuzzyTolerance(10_000, 10_500, { fuzzyTaxableTolerancePaise: 500, fuzzyTaxablePercent: 0 })).toBe(true);
  });

  it("fuzzy dates: within 5 days, both known", () => {
    expect(datesWithin("2026-09-10", "2026-09-15", 5)).toBe(true);
    expect(datesWithin("2026-09-10", "2026-09-16", 5)).toBe(false);
    expect(datesWithin("2026-09-30", "2026-10-03", 5)).toBe(true);
    expect(datesWithin(null, "2026-09-10", 5)).toBe(false);
  });

  it("matched heads: every tax head within ₹1 (inclusive)", () => {
    const base = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    expect(headsWithinTolerance({ ...base, cgst: 100, sgst: -100 })).toBe(true);
    expect(headsWithinTolerance({ ...base, cess: 101 })).toBe(false);
    expect(headsWithinTolerance({ ...base, taxable: 99_999 })).toBe(true); // taxable isn't a tax head
    expect(RECON_DEFAULTS).toMatchObject({ headTolerancePaise: 100, fuzzyTaxableTolerancePaise: 100, fuzzyTaxablePercent: "0.5", fuzzyDateWindowDays: 5 });
  });

  it("deltas are signed, 2B − books", () => {
    expect(amountDeltas({ taxable: 100, igst: 18, cgst: 0, sgst: 0, cess: 0 }, { taxable: 90, igst: 20, cgst: 0, sgst: 0, cess: 1 })).toEqual({ taxable: 10, igst: -2, cgst: 0, sgst: 0, cess: -1 });
  });
});

// -------------------------------------------------------------------------------------------------
// Tiers
// -------------------------------------------------------------------------------------------------

describe("matchDocuments: three tiers per supplier GSTIN", () => {
  it("tier 2 loose: 'INV/007' matches 'inv-7'", () => {
    const m = matchDocuments([P({ docNumber: "INV/007" })], [B({ docNumber: "inv-7" })]);
    expect(m.pairs).toEqual([{ portal: 0, books: 0, tier: "loose" }]);
  });

  it("tier 1 beats tier 2: the exact number wins and the padded copy is left over", () => {
    const m = matchDocuments([P({ docNumber: "A-1" })], [B({ docNumber: "A-01" }), B({ docNumber: " a-1 " })]);
    expect(m.pairs).toEqual([{ portal: 0, books: 1, tier: "exact" }]);
    expect(m.unmatchedBooks).toEqual([0]);
  });

  it("tier 3 fuzzy: same supplier, taxable within 0.5% and dates within 5 days", () => {
    const m = matchDocuments([P({ docNumber: "X1", docDate: "2026-09-10", taxable: 10_000_000 })], [B({ docNumber: "Y9", docDate: "2026-09-15", taxable: 10_040_000 })]);
    expect(m.pairs).toEqual([{ portal: 0, books: 0, tier: "fuzzy" }]);
  });

  it("no fuzzy match at 6 days, at 0.6%, without a date, or for another supplier", () => {
    const portal = [P({ docNumber: "X1", docDate: "2026-09-10", taxable: 10_000_000 })];
    expect(matchDocuments(portal, [B({ docNumber: "Y9", docDate: "2026-09-16", taxable: 10_000_000 })]).pairs).toEqual([]);
    expect(matchDocuments(portal, [B({ docNumber: "Y9", docDate: "2026-09-10", taxable: 10_060_000 })]).pairs).toEqual([]);
    expect(matchDocuments(portal, [B({ docNumber: "Y9", docDate: null, taxable: 10_000_000 })]).pairs).toEqual([]);
    expect(matchDocuments(portal, [B({ docNumber: "Y9", supplierGstin: SHREE, taxable: 10_000_000 })]).pairs).toEqual([]);
  });

  it("matches per supplier: the same number from two suppliers pairs with its own supplier", () => {
    const m = matchDocuments([P({ docNumber: "1", supplierGstin: SHREE }), P({ docNumber: "1" })], [B({ docNumber: "1" }), B({ docNumber: "1", supplierGstin: SHREE })]);
    expect(m.pairs.map((p) => [p.portal, p.books])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("never pairs a credit note with an invoice of the same number", () => {
    const m = matchDocuments([P({ docNumber: "7", docType: "credit_note", taxable: -1000 })], [B({ docNumber: "7", taxable: 1000 })]);
    expect(m.pairs).toEqual([]);
  });

  it("fuzzy picks the closest date; duplicates pair deterministically", () => {
    const m = matchDocuments(
      [P({ docNumber: "A", docDate: "2026-09-10" })],
      [B({ docNumber: "B", docDate: "2026-09-14" }), B({ docNumber: "C", docDate: "2026-09-11" })],
    );
    expect(m.pairs).toEqual([{ portal: 0, books: 1, tier: "fuzzy" }]);
    const d = matchDocuments(
      [P({ docNumber: "D", docDate: "2026-09-02" }), P({ docNumber: "D", docDate: "2026-09-20" })],
      [B({ docNumber: "D", docDate: "2026-09-19" }), B({ docNumber: "D", docDate: "2026-09-01" })],
    );
    expect(d.pairs).toEqual([
      { portal: 0, books: 1, tier: "exact" },
      { portal: 1, books: 0, tier: "exact" },
    ]);
  });

  it("documents without numbers never number-match, but can still fuzzy-match", () => {
    const m = matchDocuments([P({ docNumber: "" })], [B({ docNumber: "", docDate: "2026-09-30" }), B({ docNumber: "", docDate: "2026-09-12" })]);
    expect(m.pairs).toEqual([{ portal: 0, books: 1, tier: "fuzzy" }]);
  });
});

// -------------------------------------------------------------------------------------------------
// The September fixture, end to end
// -------------------------------------------------------------------------------------------------

describe("reconcile: buckets and tiers on the September fixture", () => {
  it("puts every document in exactly one bucket", () => {
    expect(sep.summary.documents).toEqual({ portal: 12, books: 10 });
    const counts = Object.fromEntries(Object.entries(sep.summary.buckets).map(([k, v]) => [k, v.count]));
    expect(counts).toEqual({ matched: 7, mismatch: 1, missing_in_books: 4, missing_in_2b: 2 });
    expect(sep.summary.byTier).toEqual({ exact: 5, loose: 2, fuzzy: 1 });
    expect(sep.entries).toHaveLength(14);
  });

  it("tiers on the pairs", () => {
    expect(entryFor(sep, "INV/007")).toMatchObject({ bucket: "matched", tier: "loose" });
    expect(entryFor(sep, "CN-5")).toMatchObject({ bucket: "matched", tier: "loose" });
    expect(entryFor(sep, "KT-101")).toMatchObject({ bucket: "matched", tier: "exact" });
    expect(entryFor(sep, "MS/2026/0450")).toMatchObject({ bucket: "matched", tier: "fuzzy", dateDeltaDays: -2 });
    expect(entryFor(sep, "1234567")).toMatchObject({ bucket: "matched", tier: "exact", supplierGstin: "" });
    expect(entryFor(sep, "MS/2026/0450").notes[0]).toContain("Matched on amount and date");
  });

  it("mismatch carries signed deltas per head", () => {
    const e = entryFor(sep, "KT-102");
    expect(e).toMatchObject({ bucket: "mismatch", tier: "exact" });
    expect(e.deltas).toEqual({ taxable: 0, igst: 0, cgst: 10_000, sgst: 10_000, cess: 0 });
    expect(e.itc).toEqual({ portal: 360_000, books: 340_000 });
    expect(e.notes).toContain("CGST: 2B ₹1,800.00, books ₹1,700.00 (2B ₹100.00 more).");
  });

  it("leftovers: in 2B not in books, and in books not in 2B", () => {
    const missingInBooks = sep.entries.filter((e) => e.bucket === "missing_in_books").map((e) => e.portal?.docNumber);
    expect(missingInBooks.sort()).toEqual(["DN-1", "ISD-1", "MS/2026/0460", "TL/88"]);
    const missingIn2b = sep.entries.filter((e) => e.bucket === "missing_in_2b").map((e) => e.books?.docNumber);
    expect(missingIn2b.sort()).toEqual(["KT-110", "PE/55"]);
    expect(entryFor(sep, "KT-110").notes[0]).toContain("ITC at risk");
    expect(entryFor(sep, "MS/2026/0460").notes[0]).toContain("unclaimed ITC");
    expect(entryFor(sep, "TL/88").notes).toContain("2B marks this ITC as not available (P).");
  });

  it("bucket totals per side", () => {
    const m = sep.summary.buckets.matched;
    expect(m.portal.taxable).toBe(1_000_000 + 500_000 + 10_000_000 + 3_000_000 + 200_000 - 100_000 + 4_000_000);
    expect(m.books.taxable).toBe(m.portal.taxable);
    expect(m.booksItc).toBe(3_348_000);
    expect(sep.summary.buckets.missing_in_2b).toMatchObject({ count: 2, booksItc: 486_000, portalItc: 0 });
    expect(sep.summary.buckets.missing_in_books.portalItc).toBe(900_000 + 144_000 + 9_000 + 50_000);
  });

  it("ITC summary: per 2B, per books, matched, mismatched, unclaimed, at risk", () => {
    expect(sep.summary.itc).toEqual({
      per2b: 4_667_000,
      notAvailablePer2b: 144_000,
      perBooks: 4_174_000,
      matched: 3_348_000,
      mismatched: 340_000,
      mismatchDifference: 20_000,
      unclaimed: 959_000,
      reversalPending: 0,
      atRisk: 486_000,
      atRiskMissingIn2b: 486_000,
      atRiskExcessOverTwoB: 0,
      available: 4_667_000,
    });
  });

  it("supplier roll-up: whom to chase, highest value at risk first", () => {
    expect(sep.suppliers.slice(0, 3).map((s) => s.supplierGstin)).toEqual([KAVERI, PRAKASH, MAHALAXMI]);
    const k = sep.suppliers[0];
    expect(k).toMatchObject({ supplierName: "Kaveri Traders", itcAtRisk: 270_000, mismatchDifference: 20_000, chase: true });
    expect(k.counts).toEqual({ matched: 3, mismatch: 1, missing_in_books: 0, missing_in_2b: 1 });
    expect(k.missingIn2b.map((r) => r.docNumber)).toEqual(["KT-110"]);
    expect(sep.suppliers[2]).toMatchObject({ supplierName: "Mahalaxmi Steel", unclaimedItc: 900_000, chase: false });
    expect(suppliersToChase(sep).map((s) => s.supplierGstin)).toEqual([KAVERI, PRAKASH]);
  });

  it("supplier names prefer the portal's trade name, falling back to the books", () => {
    expect(entryFor(sep, "MS/2026/0450").supplierName).toBe("Mahalaxmi Steel");
    expect(entryFor(sep, "PE/55").supplierName).toBe("Prakash Electricals");
    expect(entryFor(sep, "1234567").supplierName).toBe("Customs (ICEGATE)");
  });

  it("supplier follow-up lists the missing documents, then the mismatches", () => {
    expect(supplierFollowUpItems(sep.suppliers[0])).toEqual([
      "Invoice KT-110 dated 28 Sep 2026: taxable ₹15,000.00, GST ₹2,700.00, not in our GSTR-2B.",
      "Invoice KT-102 dated 12 Sep 2026: our books show GST ₹3,400.00, GSTR-2B shows ₹3,600.00.",
    ]);
  });

  it("entry keys are unique and stable", () => {
    const keys = sep.entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(entryFor(sep, "INV/007").key).toBe(`${KAVERI}|debit|INV7`);
    expect(reconcile(twoB.rows, books, { clientGstin: CLIENT }).entries.map((e) => e.key)).toEqual(keys);
  });

  it("no warnings when the 2B GSTIN is the client's", () => {
    expect(sep.warnings).toEqual([]);
  });
});

describe("IMS action list (§6.7, §6.12)", () => {
  it("covers B2B, B2BA, CDNR, CDNRA only, and leaves out reverse-charge documents", () => {
    const numbers = sep.ims.map((i) => i.docNumber).sort();
    expect(numbers).toEqual(["CN-5", "DN-1", "INV/007", "KT-101", "KT-102", "MS/2026/0450", "MS/2026/0460", "SS-77", "TL/88"]);
  });

  it("accept when matched; keep pending (with reasons) for mismatches and unbooked documents", () => {
    const action = (n: string) => sep.ims.find((i) => i.docNumber === n);
    expect(action("KT-101")).toMatchObject({ action: "accept", reason: "Matches the purchase register." });
    expect(action("INV/007")?.reason).toContain("written differently");
    expect(action("MS/2026/0450")?.reason).toContain("amount and date");
    expect(action("KT-102")).toMatchObject({ action: "keep_pending" });
    expect(action("KT-102")?.reason).toContain("CGST: 2B ₹1,800.00");
    expect(action("MS/2026/0460")).toMatchObject({ action: "keep_pending", itc: 900_000 });
    expect(action("MS/2026/0460")?.reason).toContain("book it and accept it; if not, reject it");
    const counts = sep.ims.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.action]: (acc[i.action] ?? 0) + 1 }), {});
    expect(counts).toEqual({ accept: 5, keep_pending: 4 });
    expect(IMS_DEEMED_ACCEPTANCE_NOTE).toContain("deemed accepted");
  });

  it("suggests reject for a 2B duplicate whose twin already matches the books", () => {
    const r = reconcile([P({ docNumber: "D-1" }), P({ docNumber: "D/01" })], [B({ docNumber: "D-1" })], { clientGstin: CLIENT });
    expect(r.ims.map((i) => [i.docNumber, i.action])).toEqual([
      ["D-1", "accept"],
      ["D/01", "reject"],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(["duplicate_in_2b"]);
  });

  it("credit notes in 2B not in the books: reversal pending, keep pending", () => {
    const r = reconcile([P({ docNumber: "CN-1", section: "cdnr", docType: "credit_note", taxable: -100_000, cgst: -9_000, sgst: -9_000 })], [], { clientGstin: CLIENT });
    expect(r.summary.itc).toMatchObject({ reversalPending: 18_000, unclaimed: 0 });
    expect(r.ims[0]).toMatchObject({ action: "keep_pending", itc: -18_000 });
    expect(r.ims[0].reason).toContain("Credit note not in the books");
  });
});

describe("mismatches and warnings", () => {
  it("books above 2B is ITC at risk (the excess)", () => {
    const r = reconcile([P({ docNumber: "M1", cgst: 80_000, sgst: 80_000 })], [B({ docNumber: "M1" })], { clientGstin: CLIENT });
    const e = r.entries[0];
    expect(e.bucket).toBe("mismatch");
    expect(e.deltas).toMatchObject({ cgst: -10_000, sgst: -10_000 });
    expect(r.summary.itc).toMatchObject({ atRisk: 20_000, atRiskExcessOverTwoB: 20_000, mismatchDifference: -20_000 });
    expect(r.suppliers[0]).toMatchObject({ itcAtRisk: 20_000, chase: true });
  });

  it("differences of up to ₹1 per head are still matched", () => {
    const r = reconcile([P({ docNumber: "M2", cgst: 90_100, sgst: 89_900, taxable: 1_000_050 })], [B({ docNumber: "M2" })], { clientGstin: CLIENT });
    expect(r.entries[0].bucket).toBe("matched");
    expect(r.entries[0].deltas).toMatchObject({ cgst: 100, sgst: -100, taxable: 50 });
  });

  it("explains IGST charged where the books have CGST + SGST (place of supply)", () => {
    const r = reconcile([P({ docNumber: "S1", igst: 180_000, cgst: 0, sgst: 0 })], [B({ docNumber: "S1" })], { clientGstin: CLIENT });
    expect(r.entries[0].bucket).toBe("mismatch");
    expect(r.entries[0].notes[0]).toBe("Charged as IGST in 2B but as CGST + SGST in the books: check the place of supply with the supplier.");
    expect(r.entries[0].deltas).toMatchObject({ igst: 180_000, cgst: -90_000, sgst: -90_000 });
  });

  it("warns about a book entry booked twice (possible double claim)", () => {
    const r = reconcile([], [B({ docNumber: "INV-9" }), B({ docNumber: "inv/09" })], { clientGstin: CLIENT });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: "duplicate_in_books", supplierGstin: KAVERI });
    expect(r.warnings[0].message).toContain("booked 2 times");
  });

  it("GSTIN check: another client's file, another state of the same PAN, missing GSTINs", () => {
    expect(checkPortalGstin(CLIENT, CLIENT)).toBeNull();
    expect(checkPortalGstin(" 29aakcb1111f1z3", CLIENT)).toBeNull();
    expect(checkPortalGstin(CLIENT, "29AAXFT1811B1Z3")?.message).toBe(
      "The GSTR-2B file is for 29AAKCB1111F1Z3, but the client's GSTIN is 29AAXFT1811B1Z3. Check that you uploaded this client's file.",
    );
    expect(checkPortalGstin("27AAKCB1111F1Z7", CLIENT)?.message).toContain("another registration of the same PAN");
    expect(checkPortalGstin(CLIENT, null)?.code).toBe("no_client_gstin");
    expect(checkPortalGstin(null, CLIENT)?.code).toBe("no_portal_gstin");
  });

  it("reconcile surfaces the GSTIN mismatch as a warning", () => {
    const r = reconcile(twoB.rows, books, { clientGstin: "29AAXFT1811B1Z3", portalGstin: twoB.gstin });
    expect(r.warnings[0]).toMatchObject({ code: "gstin_mismatch" });
    expect(reconcile([], [], { clientGstin: CLIENT, portalGstin: null }).warnings[0].code).toBe("no_portal_gstin");
    expect(reconcile([], [], { clientGstin: CLIENT }).warnings).toEqual([]);
  });

  it("takes parameters: a wider date window turns a leftover pair into a fuzzy match", () => {
    const portal = [P({ docNumber: "W1", docDate: "2026-09-01" })];
    const bk = [B({ docNumber: "W9", docDate: "2026-09-08" })];
    expect(reconcile(portal, bk, { clientGstin: CLIENT }).summary.byTier.fuzzy).toBe(0);
    expect(reconcile(portal, bk, { clientGstin: CLIENT, params: { fuzzyDateWindowDays: 7 } }).summary.byTier.fuzzy).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
// Carry-forward and export
// -------------------------------------------------------------------------------------------------

describe("carry-forward (§6.12: the next month shows what carried forward)", () => {
  const sepOpen = openItemsOf(sep, "092026", { [entryFor(sep, "TL/88").key]: "ignore", [entryFor(sep, "PE/55").key]: "follow_up_supplier" });

  // October: Kaveri reports KT-110 late; the client books Mahalaxmi's MS/2026/0460; one new invoice matches.
  const oct2b = [
    P({ docNumber: "KT-110", docDate: "2026-09-28", taxable: 1_500_000, cgst: 135_000, sgst: 135_000, supplierPeriod: "102026" }),
    P({ docNumber: "KT-120", docDate: "2026-10-05" }),
  ];
  const octBooks = [
    B({ docNumber: "KT-120", docDate: "2026-10-05" }),
    B({ docNumber: "MS-2026-460", supplierGstin: MAHALAXMI, docDate: "2026-09-25", taxable: 5_000_000, igst: 900_000, cgst: 0, sgst: 0 }),
  ];
  const oct = reconcile(oct2b, octBooks, { clientGstin: CLIENT });
  const cf = carryForward(sepOpen, oct, "102026");

  it("open items exclude matched lines and lines resolved as ignore/accepted", () => {
    expect(sepOpen.map((i) => i.portal?.docNumber ?? i.books?.docNumber).sort()).toEqual(["DN-1", "ISD-1", "KT-102", "KT-110", "MS/2026/0460", "PE/55"]);
    expect(sepOpen.every((i) => i.firstSeenPeriod === "092026")).toBe(true);
  });

  it("clears what the supplier reported late and what was booked late", () => {
    expect(cf.cleared.map((c) => [c.item.bucket, c.item.portal?.docNumber ?? c.item.books?.docNumber, c.tier])).toEqual([
      ["missing_in_2b", "KT-110", "exact"],
      ["missing_in_books", "MS/2026/0460", "loose"],
    ]);
    expect(cf.cleared[0].message).toContain("now reported it in this month's GSTR-2B (it was missing in Sep 2026)");
    expect(cf.cleared[1].message).toBe("Booked this month; it was in the GSTR-2B for Sep 2026.");
    expect(cf.cleared.every((c) => c.amountsAgree)).toBe(true);
    expect(cf.explainedEntryKeys.sort()).toEqual([entryFor(oct, "KT-110").key, entryFor(oct, "MS-2026-460").key].sort());
  });

  it("keeps the rest open with its age, and carries everything still open into next month", () => {
    expect(cf.stillOpen.map((i) => i.portal?.docNumber ?? i.books?.docNumber).sort()).toEqual(["DN-1", "ISD-1", "KT-102", "PE/55"]);
    expect(cf.stillOpen.every((i) => i.monthsOpen === 1)).toBe(true);
    const next = cf.openForNextMonth.map((i) => `${i.firstSeenPeriod}:${i.portal?.docNumber ?? i.books?.docNumber}`).sort();
    expect(next).toEqual(["092026:DN-1", "092026:ISD-1", "092026:KT-102", "092026:PE/55"]);
    expect(cf.openForNextMonth.some((i) => "monthsOpen" in i)).toBe(false);
  });

  it("this month's own open lines carry forward too", () => {
    const nov = reconcile([], [B({ docNumber: "KT-130", docDate: "2026-11-02" })], { clientGstin: CLIENT });
    const r = carryForward(cf.openForNextMonth, nov, "112026");
    expect(r.openForNextMonth.find((i) => i.books?.docNumber === "KT-130")?.firstSeenPeriod).toBe("112026");
    expect(r.stillOpen.find((i) => i.books?.docNumber === "PE/55")?.monthsOpen).toBe(2);
  });

  it("flags a late arrival whose amounts differ", () => {
    const prev = openItemsOf(reconcile([], [B({ docNumber: "L1" })], { clientGstin: CLIENT }), "092026");
    const cur = reconcile([P({ docNumber: "L1", cgst: 80_000, sgst: 80_000 })], [], { clientGstin: CLIENT });
    const r = carryForward(prev, cur, "102026");
    expect(r.cleared[0].amountsAgree).toBe(false);
    expect(r.cleared[0].message).toContain("The amounts differ from the books");
  });

  it("monthsBetweenPeriods", () => {
    expect(monthsBetweenPeriods("082026", "102026")).toBe(2);
    expect(monthsBetweenPeriods("122026", "012027")).toBe(1);
    expect(monthsBetweenPeriods("2026-08", "102026")).toBeNull();
  });
});

describe("export rows (§6.12 Excel export)", () => {
  it("one row per entry, aligned with the headers, amounts in rupees", () => {
    const rows = reconExportRows(sep);
    expect(rows).toHaveLength(sep.entries.length);
    expect(rows.every((r) => r.length === RECON_EXPORT_HEADERS.length)).toBe(true);
    const kt102 = rows[sep.entries.findIndex((e) => e.portal?.docNumber === "KT-102")];
    expect(kt102.slice(0, 9)).toEqual(["Mismatch", "Exact document number", KAVERI, "Kaveri Traders", "Invoice", "KT-102", "2026-09-12", "KT-102", "2026-09-12"]);
    expect(kt102[13]).toBe(1800);
    expect(kt102[14]).toBe(1700);
    expect(kt102[19]).toBe(200);
    const kt110 = rows[sep.entries.findIndex((e) => e.books?.docNumber === "KT-110")];
    expect(kt110[5]).toBeNull();
    expect(kt110[19]).toBe(-2700);
  });
});
