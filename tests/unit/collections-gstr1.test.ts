import { describe, expect, it } from "vitest";
import {
  buildGstr1,
  gstr1ExcelDate,
  gstr1Json,
  gstr1JsonDate,
  gstr1PeriodProblem,
  gstr1Pos,
  gstr1Sheets,
  lineTax,
  parseGstr1Period,
  type Gstr1CreditNote,
  type Gstr1Invoice,
} from "@/lib/domain/gstr1";

const OPTS = { firmStateCode: "29", b2clThresholdPaise: 100_000_00 };

function inv(over: Partial<Gstr1Invoice>): Gstr1Invoice {
  return {
    id: "i",
    number: "TW/26-27/0001",
    date: "2026-09-05",
    kind: "tax_invoice",
    cancelled: false,
    recipientGstin: "29AABCA1234A1Z5",
    recipientName: "Alpha Traders Pvt Ltd",
    placeOfSupply: "29",
    reverseCharge: false,
    totalPaise: 11800_00,
    lines: [{ sac: "998231", description: "GST returns for Sep 2026", amountPaise: 10000_00, taxRate: 18, isReimbursement: false }],
    ...over,
  };
}

function cn(over: Partial<Gstr1CreditNote>): Gstr1CreditNote {
  return {
    id: "c",
    number: "TW-CN/26-27/0001",
    date: "2026-09-20",
    reducesGst: true,
    recipientGstin: "29AABCA1234A1Z5",
    recipientName: "Alpha Traders Pvt Ltd",
    placeOfSupply: "29",
    taxablePaise: 1000_00,
    taxRate: 18,
    cgstPaise: 90_00,
    sgstPaise: 90_00,
    igstPaise: 0,
    totalPaise: 1180_00,
    sac: "998231",
    original: { number: "TW/26-27/0001", date: "2026-09-05", totalPaise: 11800_00, placeOfSupply: "29" },
    ...over,
  };
}

describe("GSTR-1 periods and formats", () => {
  it("reads a month or a quarter and gives the return period", () => {
    expect(parseGstr1Period("2026-09")).toEqual({ kind: "month", from: "2026-09-01", to: "2026-09-30", fp: "092026", label: "Sep 2026" });
    expect(parseGstr1Period("Q3 2026-27")).toEqual({ kind: "quarter", from: "2026-10-01", to: "2026-12-31", fp: "122026", label: "Q3 2026-27" });
    expect(parseGstr1Period("Q4 2026-27")?.fp).toBe("032027");
    expect(parseGstr1Period("2026-13")).toBeNull();
    expect(parseGstr1Period("Sep 2026")).toBeNull();
    expect(gstr1PeriodProblem(parseGstr1Period("2026-11")!, "2026-10-23")).toBe("That period hasn't started yet.");
    expect(gstr1PeriodProblem(parseGstr1Period("2026-10")!, "2026-10-23")).toBeNull();
  });

  it("writes dates and places of supply as the portal does", () => {
    expect(gstr1ExcelDate("2026-10-05")).toBe("05-Oct-2026");
    expect(gstr1JsonDate("2026-10-05")).toBe("05-10-2026");
    expect(gstr1Pos("29")).toBe("29-Karnataka");
    expect(gstr1Pos("27")).toBe("27-Maharashtra");
  });

  it("splits a line's tax exactly as the invoice did", () => {
    expect(lineTax(10005, 18, true)).toEqual({ taxPaise: 1801, cgstPaise: 901, sgstPaise: 900, igstPaise: 0 });
    expect(lineTax(10005, 18, false)).toEqual({ taxPaise: 1801, cgstPaise: 0, sgstPaise: 0, igstPaise: 1801 });
  });
});

describe("buildGstr1 (§7.9.8)", () => {
  it("sorts invoices into B2B, B2CL and B2CS, leaves out reimbursements and cancelled invoices, and counts documents", () => {
    const g = buildGstr1(
      {
        invoices: [
          inv({ id: "a", number: "TW/26-27/0001", lines: [
            { sac: "998231", description: "GST returns", amountPaise: 10000_00, taxRate: 18, isReimbursement: false },
            { sac: "9982", description: "ROC fee paid on your behalf (reimbursement of expenses incurred as pure agent)", amountPaise: 600_00, taxRate: 0, isReimbursement: true },
          ], totalPaise: 12400_00 }),
          // Unregistered, out of state, above ₹1,00,000: B2CL.
          inv({ id: "b", number: "TW/26-27/0002", recipientGstin: null, recipientName: "Rakesh Sharma", placeOfSupply: "27", totalPaise: 118000_00, lines: [{ sac: "998232", description: "Income tax", amountPaise: 100000_00, taxRate: 18, isReimbursement: false }] }),
          // Unregistered, out of state, at the threshold: B2CS.
          inv({ id: "c", number: "TW/26-27/0003", recipientGstin: null, recipientName: "Meena", placeOfSupply: "27", totalPaise: 100000_00, lines: [{ sac: "998232", description: "Income tax", amountPaise: 84745_76, taxRate: 18, isReimbursement: false }] }),
          // Unregistered, local: B2CS, plus a 0% line to the exempt table.
          inv({ id: "d", number: "TW/26-27/0004", recipientGstin: null, recipientName: "Local client", totalPaise: 1680_00, lines: [
            { sac: "998232", description: "ITR filing", amountPaise: 1000_00, taxRate: 18, isReimbursement: false },
            { sac: "998232", description: "Exempt service", amountPaise: 500_00, taxRate: 0, isReimbursement: false },
          ] }),
          inv({ id: "e", number: "TW/26-27/0005", cancelled: true }),
        ],
        creditNotes: [],
      },
      OPTS,
    );
    expect(g.b2b).toEqual([
      expect.objectContaining({ gstin: "29AABCA1234A1Z5", invoiceNumber: "TW/26-27/0001", invoiceValuePaise: 12400_00, ratePercent: 18, taxablePaise: 10000_00, cgstPaise: 900_00, sgstPaise: 900_00, igstPaise: 0 }),
    ]);
    expect(g.b2cl).toEqual([expect.objectContaining({ invoiceNumber: "TW/26-27/0002", placeOfSupply: "27", taxablePaise: 100000_00, igstPaise: 18000_00 })]);
    expect(g.b2cs).toEqual([
      expect.objectContaining({ placeOfSupply: "27", supplyType: "INTER", ratePercent: 18, taxablePaise: 84745_76, igstPaise: 15254_24 }),
      expect.objectContaining({ placeOfSupply: "29", supplyType: "INTRA", ratePercent: 18, taxablePaise: 1000_00, cgstPaise: 90_00, sgstPaise: 90_00 }),
    ]);
    expect(g.exempt).toEqual([{ description: "Intra-State supplies to unregistered persons", nilRatedPaise: 0, exemptedPaise: 500_00, nonGstPaise: 0 }]);
    expect(g.docs).toEqual([{ nature: "Invoices for outward supply", docNum: 1, from: "TW/26-27/0001", to: "TW/26-27/0005", total: 5, cancelled: 1 }]);
    expect(g.hsnB2b).toEqual([expect.objectContaining({ hsn: "998231", description: "Corporate tax consulting and preparation services", uqc: "NA", ratePercent: 18, taxablePaise: 10000_00, totalValuePaise: 11800_00 })]);
    const b2cHsn = g.hsnB2c.find((r) => r.ratePercent === 18)!;
    expect(b2cHsn.taxablePaise).toBe(100000_00 + 84745_76 + 1000_00);
    expect(g.hsnB2c.find((r) => r.ratePercent === 0)?.taxablePaise).toBe(500_00);
    expect(g.totals.invoices).toBe(4);
  });

  it("reports credit and debit notes: CDNR for registered, CDNUR for B2CL invoices, B2CS adjustments otherwise", () => {
    const g = buildGstr1(
      {
        invoices: [
          inv({ id: "d1", number: "TW/26-27/0010", kind: "debit_note", totalPaise: 2360_00, lines: [{ sac: "998231", description: "Additional fee", amountPaise: 2000_00, taxRate: 18, isReimbursement: false }], original: { number: "TW/26-27/0001", date: "2026-08-01", totalPaise: 11800_00, placeOfSupply: "29" } }),
          inv({ id: "local", number: "TW/26-27/0011", recipientGstin: null, recipientName: "Local", totalPaise: 5900_00, lines: [{ sac: "998232", description: "ITR", amountPaise: 5000_00, taxRate: 18, isReimbursement: false }] }),
        ],
        creditNotes: [
          cn({}),
          cn({ id: "c2", number: "TW-CN/26-27/0002", recipientGstin: null, recipientName: "Rakesh", placeOfSupply: "27", cgstPaise: 0, sgstPaise: 0, igstPaise: 180_00, original: { number: "TW/26-27/0002", date: "2026-09-05", totalPaise: 118000_00, placeOfSupply: "27" } }),
          cn({ id: "c3", number: "TW-CN/26-27/0003", recipientGstin: null, recipientName: "Local", taxablePaise: 1000_00, original: { number: "TW/26-27/0011", date: "2026-09-05", totalPaise: 5900_00, placeOfSupply: "29" } }),
          cn({ id: "c4", number: "TW-CN/26-27/0004", reducesGst: false }),
        ],
      },
      OPTS,
    );
    expect(g.cdnr.map((r) => [r.noteNumber, r.noteType, r.taxablePaise])).toEqual([
      ["TW-CN/26-27/0001", "C", 1000_00],
      ["TW/26-27/0010", "D", 2000_00],
    ]);
    expect(g.cdnur).toEqual([expect.objectContaining({ urType: "B2CL", noteNumber: "TW-CN/26-27/0002", noteType: "C", igstPaise: 180_00 })]);
    // The local B2CS invoice of 5,000 less its 1,000 credit note.
    expect(g.b2cs).toEqual([expect.objectContaining({ placeOfSupply: "29", taxablePaise: 4000_00, cgstPaise: 360_00, sgstPaise: 360_00 })]);
    // The commercial credit note isn't reported, but is counted.
    expect(g.docs.find((d) => d.nature === "Credit Note")).toEqual({ nature: "Credit Note", docNum: 5, from: "TW-CN/26-27/0001", to: "TW-CN/26-27/0004", total: 4, cancelled: 0 });
    expect(g.docs.find((d) => d.nature === "Debit Note")?.total).toBe(1);
    // HSN: +2,000 debit note − 1,000 credit note for the registered recipient.
    expect(g.hsnB2b).toEqual([expect.objectContaining({ hsn: "998231", taxablePaise: 1000_00 })]);
    expect(g.totals.notes).toBe(4);
  });

  it("lays out the workbook as the offline tool does, and builds the JSON", () => {
    const g = buildGstr1({ invoices: [inv({}), inv({ id: "b", number: "TW/26-27/0002", recipientGstin: null, recipientName: "Rakesh", placeOfSupply: "27", totalPaise: 118000_00, lines: [{ sac: "998232", description: "Income tax", amountPaise: 100000_00, taxRate: 18, isReimbursement: false }] })], creditNotes: [] }, OPTS);
    const sheets = gstr1Sheets(g);
    expect(sheets.map((s) => s.name)).toEqual(["b2b, sez, de", "b2cl", "b2cs", "cdnr", "cdnur", "exemp", "hsn(b2b)", "hsn(b2c)", "docs"]);
    const b2b = sheets[0];
    expect(b2b.headers[0]).toBe("GSTIN/UIN of Recipient");
    expect(b2b.rows[0]).toEqual(["29AABCA1234A1Z5", "Alpha Traders Pvt Ltd", "TW/26-27/0001", "05-Sep-2026", 11800, "29-Karnataka", "N", "", "Regular B2B", "", 18, 10000, 0]);
    expect(b2b.summary.find((s) => s.label === "Total Taxable Value")?.value).toBe(10000);

    const json = gstr1Json(g, { gstin: "29AAXFT1811B1Z3", fp: "092026" });
    expect(json).toMatchObject({ gstin: "29AAXFT1811B1Z3", fp: "092026" });
    expect(json.b2b).toEqual([
      {
        ctin: "29AABCA1234A1Z5",
        inv: [{ inum: "TW/26-27/0001", idt: "05-09-2026", val: 11800, pos: "29", rchrg: "N", inv_typ: "R", itms: [{ num: 1, itm_det: { txval: 10000, rt: 18, iamt: 0, camt: 900, samt: 900, csamt: 0 } }] }],
      },
    ]);
    expect(json.b2cl).toEqual([{ pos: "27", inv: [{ inum: "TW/26-27/0002", idt: "05-09-2026", val: 118000, itms: [{ num: 1, itm_det: { txval: 100000, rt: 18, iamt: 18000, csamt: 0 } }] }] }]);
    expect(json).not.toHaveProperty("cdnr");
    expect(json.doc_issue).toEqual({ doc_det: [{ doc_num: 1, doc_typ: "Invoices for outward supply", docs: [{ num: 1, from: "TW/26-27/0001", to: "TW/26-27/0002", totnum: 2, cancel: 0, net_issue: 2 }] }] });
  });
});
