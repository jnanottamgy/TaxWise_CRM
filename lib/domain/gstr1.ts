/**
 * TaxWise's own GSTR-1 (§7.9.8): the outward supplies of a month or quarter sorted into the
 * portal's tables, B2B (4A), B2CL (5), B2CS (7), CDNR / CDNUR (9B), nil-rated and exempt (8), the
 * HSN/SAC summary (12, split B2B / B2C) and the documents issued (13), in the shapes the GST
 * offline tool's Excel workbook and the GSTR-1 JSON use. [verify the column headings and the JSON
 * version against the offline tool in use when filing]
 *
 * Rules applied:
 * - Tax per line is recomputed exactly as invoices are (lib/domain/gst.ts): `round(amount × rate%)`,
 *   CGST = half rounded half-up, SGST the rest; IGST when the place of supply is outside the firm's
 *   state. Pure-agent reimbursements (Rule 33) are not supplies and are left out of every table.
 * - Registered recipient (GSTIN on the invoice) → B2B; unregistered and inter-state above the B2CL
 *   threshold (a law parameter, gst.gstr1_b2cl_threshold) → B2CL; every other unregistered supply →
 *   B2CS, summarised by place of supply and rate. 0% lines go to the nil-rated / exempt table.
 * - Credit notes that reduce GST, and debit notes, to registered recipients → CDNR; to unregistered
 *   recipients on a B2CL invoice → CDNUR (B2CL); the rest adjust B2CS (credit notes reduce it).
 *   A commercial credit note (no GST reduced, after the s.34 deadline, §6.4) isn't reported, but is
 *   counted in the documents issued.
 * - Cancelled invoices are left out of the tables and counted as cancelled in Table 13.
 *
 * Pure and client-safe. Amounts are integer paise; the JSON and the sheets carry rupees.
 */

import { compareDates, financialYearOf, isDateString, MONTH_ABBR, parsePeriodLabel, type DateString } from "@/lib/domain/fy";
import { fromPaise, percentOf, type Paise } from "@/lib/domain/money";
import { splitTax } from "@/lib/domain/gst";
import { stateName } from "@/lib/domain/india-validators";

// -------------------------------------------------------------------------------------------------
// Period
// -------------------------------------------------------------------------------------------------

export type Gstr1Period = {
  kind: "month" | "quarter";
  from: DateString;
  to: DateString;
  /** The return period the portal uses: MMYYYY of the last month (`092026`). */
  fp: string;
  /** "Sep 2026", "Q2 2026-27". */
  label: string;
};

/** Reads `2026-09` (a month) or `Q2 2026-27` (a quarter). Null for anything else. */
export function parseGstr1Period(input: string | null | undefined): Gstr1Period | null {
  const text = (input ?? "").trim();
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    const label = `${MONTH_ABBR[m - 1]} ${month[1]}`;
    const p = parsePeriodLabel(label);
    if (!p) return null;
    return { kind: "month", from: p.start, to: p.end, fp: `${month[2]}${month[1]}`, label };
  }
  const p = parsePeriodLabel(text);
  if (p && p.kind === "quarter") return { kind: "quarter", from: p.start, to: p.end, fp: `${p.end.slice(5, 7)}${p.end.slice(0, 4)}`, label: text };
  return null;
}

// -------------------------------------------------------------------------------------------------
// Input
// -------------------------------------------------------------------------------------------------

export type Gstr1Line = {
  sac: string;
  description: string;
  amountPaise: Paise;
  taxRate: number | string;
  isReimbursement: boolean;
};

export type Gstr1Invoice = {
  id: string;
  number: string;
  date: DateString;
  kind: "tax_invoice" | "debit_note";
  cancelled: boolean;
  recipientGstin: string | null;
  recipientName: string;
  /** Two-digit state code. */
  placeOfSupply: string;
  reverseCharge: boolean;
  totalPaise: Paise;
  lines: readonly Gstr1Line[];
  /** For a debit note: the invoice it increases (decides CDNUR / B2CS for an unregistered recipient). */
  original?: { number: string; date: DateString; totalPaise: Paise; placeOfSupply: string } | null;
};

export type Gstr1CreditNote = {
  id: string;
  number: string;
  date: DateString;
  /** False for a commercial credit after the s.34 deadline: not in the tables. */
  reducesGst: boolean;
  recipientGstin: string | null;
  recipientName: string;
  placeOfSupply: string;
  taxablePaise: Paise;
  taxRate: number | string;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  totalPaise: Paise;
  /** The SAC of the invoice it credits, for the HSN summary. */
  sac: string;
  original: { number: string; date: DateString; totalPaise: Paise; placeOfSupply: string };
};

export type Gstr1Options = {
  firmStateCode: string;
  /** Inter-state B2C invoices above this go to B2CL (gst.gstr1_b2cl_threshold). */
  b2clThresholdPaise: Paise;
  b2clInclusive?: boolean;
};

/** The law default when the parameter row is missing: ₹1,00,000 from 1 Aug 2024 (the migration seeds the row). */
export const GSTR1_DEFAULTS = { b2clThresholdPaise: 100_000_00, b2clInclusive: false } as const;

// -------------------------------------------------------------------------------------------------
// Output
// -------------------------------------------------------------------------------------------------

type Tax = { igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise };

export type Gstr1B2bRow = Tax & {
  gstin: string;
  receiverName: string;
  invoiceNumber: string;
  invoiceDate: DateString;
  invoiceValuePaise: Paise;
  placeOfSupply: string;
  reverseCharge: boolean;
  ratePercent: number;
  taxablePaise: Paise;
};

export type Gstr1B2clRow = {
  invoiceNumber: string;
  invoiceDate: DateString;
  invoiceValuePaise: Paise;
  placeOfSupply: string;
  ratePercent: number;
  taxablePaise: Paise;
  igstPaise: Paise;
};

export type Gstr1B2csRow = Tax & { placeOfSupply: string; supplyType: "INTRA" | "INTER"; ratePercent: number; taxablePaise: Paise };

export type Gstr1NoteRow = Tax & {
  /** CDNR: the recipient's GSTIN and name. */
  gstin: string | null;
  receiverName: string;
  noteNumber: string;
  noteDate: DateString;
  noteType: "C" | "D";
  placeOfSupply: string;
  reverseCharge: boolean;
  noteValuePaise: Paise;
  ratePercent: number;
  taxablePaise: Paise;
  /** CDNUR: B2CL. */
  urType: "B2CL" | null;
};

export const EXEMPT_CATEGORIES = [
  "Inter-State supplies to registered persons",
  "Intra-State supplies to registered persons",
  "Inter-State supplies to unregistered persons",
  "Intra-State supplies to unregistered persons",
] as const;
export type ExemptCategory = (typeof EXEMPT_CATEGORIES)[number];

export type Gstr1ExemptRow = { description: ExemptCategory; nilRatedPaise: Paise; exemptedPaise: Paise; nonGstPaise: Paise };

export type Gstr1HsnRow = Tax & { hsn: string; description: string; uqc: string; quantity: number; totalValuePaise: Paise; ratePercent: number; taxablePaise: Paise };

export type Gstr1DocRow = { nature: "Invoices for outward supply" | "Debit Note" | "Credit Note"; docNum: number; from: string; to: string; total: number; cancelled: number };

export type Gstr1Return = {
  b2b: Gstr1B2bRow[];
  b2cl: Gstr1B2clRow[];
  b2cs: Gstr1B2csRow[];
  cdnr: Gstr1NoteRow[];
  cdnur: Gstr1NoteRow[];
  exempt: Gstr1ExemptRow[];
  hsnB2b: Gstr1HsnRow[];
  hsnB2c: Gstr1HsnRow[];
  docs: Gstr1DocRow[];
  /** Taxable value and tax across the tables, for the summary line on screen. */
  totals: Tax & { taxablePaise: Paise; invoices: number; notes: number };
};

// -------------------------------------------------------------------------------------------------
// Building
// -------------------------------------------------------------------------------------------------

function rateOf(v: number | string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`Not a GST rate: ${String(v)}`);
  return n;
}

/** One line's tax, exactly as the invoice computed it (§6.4). */
export function lineTax(amountPaise: Paise, taxRate: number | string, intraState: boolean): Tax & { taxPaise: Paise } {
  const taxPaise = percentOf(amountPaise, taxRate);
  return { taxPaise, ...splitTax(taxPaise, intraState) };
}

/** Standard descriptions of the SACs the firm uses (§6.4); others print the line's description. */
const SAC_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "9982": "Legal and accounting services",
  "99822": "Accounting, auditing and bookkeeping services",
  "998221": "Financial auditing services",
  "998222": "Accounting and bookkeeping services",
  "998223": "Payroll services",
  "998224": "Other similar services",
  "99823": "Tax consultancy and preparation services",
  "998231": "Corporate tax consulting and preparation services",
  "998232": "Individual tax preparation and planning services",
};

function sacDescription(sac: string, fallback: string): string {
  return SAC_DESCRIPTIONS[sac] ?? fallback.slice(0, 30);
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

type RateBucket = Tax & { ratePercent: number; taxablePaise: Paise };

function byRate(lines: readonly Gstr1Line[], intra: boolean): { taxed: RateBucket[]; zeroPaise: Paise } {
  const buckets = new Map<number, RateBucket>();
  let zero = 0;
  for (const l of lines) {
    if (l.isReimbursement) continue;
    const rate = rateOf(l.taxRate);
    if (rate === 0) {
      zero += l.amountPaise;
      continue;
    }
    const t = lineTax(l.amountPaise, rate, intra);
    const b = buckets.get(rate) ?? { ratePercent: rate, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
    b.taxablePaise += l.amountPaise;
    b.igstPaise += t.igstPaise;
    b.cgstPaise += t.cgstPaise;
    b.sgstPaise += t.sgstPaise;
    buckets.set(rate, b);
  }
  return { taxed: [...buckets.values()].sort((a, b) => a.ratePercent - b.ratePercent), zeroPaise: zero };
}

function overThreshold(valuePaise: Paise, opts: Gstr1Options): boolean {
  return opts.b2clInclusive ? valuePaise >= opts.b2clThresholdPaise : valuePaise > opts.b2clThresholdPaise;
}

function exemptCategory(registered: boolean, inter: boolean): ExemptCategory {
  if (registered) return inter ? EXEMPT_CATEGORIES[0] : EXEMPT_CATEGORIES[1];
  return inter ? EXEMPT_CATEGORIES[2] : EXEMPT_CATEGORIES[3];
}

/**
 * Sorts the period's invoices, debit notes and credit notes into the GSTR-1 tables. Pass every
 * document dated in the period (cancelled ones too: they count in Table 13).
 */
export function buildGstr1(input: { invoices: readonly Gstr1Invoice[]; creditNotes: readonly Gstr1CreditNote[] }, opts: Gstr1Options): Gstr1Return {
  const b2b: Gstr1B2bRow[] = [];
  const b2cl: Gstr1B2clRow[] = [];
  const b2csMap = new Map<string, Gstr1B2csRow>();
  const cdnr: Gstr1NoteRow[] = [];
  const cdnur: Gstr1NoteRow[] = [];
  const exempt = new Map<ExemptCategory, Gstr1ExemptRow>(EXEMPT_CATEGORIES.map((d) => [d, { description: d, nilRatedPaise: 0, exemptedPaise: 0, nonGstPaise: 0 }]));
  const hsn = { b2b: new Map<string, Gstr1HsnRow>(), b2c: new Map<string, Gstr1HsnRow>() };

  const addB2cs = (pos: string, inter: boolean, b: RateBucket, sign: 1 | -1) => {
    const key = `${pos}|${b.ratePercent}`;
    const row = b2csMap.get(key) ?? { placeOfSupply: pos, supplyType: inter ? ("INTER" as const) : ("INTRA" as const), ratePercent: b.ratePercent, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
    row.taxablePaise += sign * b.taxablePaise;
    row.igstPaise += sign * b.igstPaise;
    row.cgstPaise += sign * b.cgstPaise;
    row.sgstPaise += sign * b.sgstPaise;
    b2csMap.set(key, row);
  };
  const addHsn = (registered: boolean, sac: string, description: string, rate: number, taxable: Paise, tax: Tax, sign: 1 | -1) => {
    const map = registered ? hsn.b2b : hsn.b2c;
    const key = `${sac}|${rate}`;
    const row = map.get(key) ?? { hsn: sac, description: sacDescription(sac, description), uqc: "NA", quantity: 0, totalValuePaise: 0, ratePercent: rate, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
    row.taxablePaise += sign * taxable;
    row.igstPaise += sign * tax.igstPaise;
    row.cgstPaise += sign * tax.cgstPaise;
    row.sgstPaise += sign * tax.sgstPaise;
    row.totalValuePaise += sign * (taxable + tax.igstPaise + tax.cgstPaise + tax.sgstPaise);
    map.set(key, row);
  };

  let invoices = 0;
  let notes = 0;

  for (const inv of input.invoices) {
    if (inv.cancelled) continue;
    const intra = inv.placeOfSupply === opts.firmStateCode;
    const registered = Boolean(inv.recipientGstin);
    const { taxed, zeroPaise } = byRate(inv.lines, intra);
    for (const l of inv.lines) {
      if (l.isReimbursement) continue;
      const rate = rateOf(l.taxRate);
      addHsn(registered, l.sac, l.description, rate, l.amountPaise, lineTax(l.amountPaise, rate, intra), 1);
    }

    if (inv.kind === "tax_invoice") {
      invoices++;
      if (zeroPaise > 0) exempt.get(exemptCategory(registered, !intra))!.exemptedPaise += zeroPaise;
      if (registered) {
        for (const b of taxed) {
          b2b.push({
            gstin: inv.recipientGstin!,
            receiverName: inv.recipientName,
            invoiceNumber: inv.number,
            invoiceDate: inv.date,
            invoiceValuePaise: inv.totalPaise,
            placeOfSupply: inv.placeOfSupply,
            reverseCharge: inv.reverseCharge,
            ...b,
          });
        }
      } else if (!intra && overThreshold(inv.totalPaise, opts)) {
        for (const b of taxed) b2cl.push({ invoiceNumber: inv.number, invoiceDate: inv.date, invoiceValuePaise: inv.totalPaise, placeOfSupply: inv.placeOfSupply, ratePercent: b.ratePercent, taxablePaise: b.taxablePaise, igstPaise: b.igstPaise });
      } else {
        for (const b of taxed) addB2cs(inv.placeOfSupply, !intra, b, 1);
      }
      continue;
    }

    // Debit note.
    notes++;
    if (zeroPaise > 0) exempt.get(exemptCategory(registered, !intra))!.exemptedPaise += zeroPaise;
    const originalValue = inv.original?.totalPaise ?? inv.totalPaise;
    const note = (b: RateBucket, urType: "B2CL" | null): Gstr1NoteRow => ({
      gstin: inv.recipientGstin,
      receiverName: inv.recipientName,
      noteNumber: inv.number,
      noteDate: inv.date,
      noteType: "D",
      placeOfSupply: inv.placeOfSupply,
      reverseCharge: inv.reverseCharge,
      noteValuePaise: inv.totalPaise,
      urType,
      ...b,
    });
    if (registered) for (const b of taxed) cdnr.push(note(b, null));
    else if (!intra && overThreshold(originalValue, opts)) for (const b of taxed) cdnur.push(note(b, "B2CL"));
    else for (const b of taxed) addB2cs(inv.placeOfSupply, !intra, b, 1);
  }

  for (const cn of input.creditNotes) {
    if (!cn.reducesGst) continue;
    notes++;
    const intra = cn.placeOfSupply === opts.firmStateCode;
    const registered = Boolean(cn.recipientGstin);
    const rate = rateOf(cn.taxRate);
    const tax: Tax = { igstPaise: cn.igstPaise, cgstPaise: cn.cgstPaise, sgstPaise: cn.sgstPaise };
    addHsn(registered, cn.sac, "Credit note", rate, cn.taxablePaise, tax, -1);
    if (rate === 0) {
      exempt.get(exemptCategory(registered, !intra))!.exemptedPaise -= cn.taxablePaise;
      continue;
    }
    const bucket: RateBucket = { ratePercent: rate, taxablePaise: cn.taxablePaise, ...tax };
    const row: Gstr1NoteRow = {
      gstin: cn.recipientGstin,
      receiverName: cn.recipientName,
      noteNumber: cn.number,
      noteDate: cn.date,
      noteType: "C",
      placeOfSupply: cn.placeOfSupply,
      reverseCharge: false,
      noteValuePaise: cn.totalPaise,
      urType: null,
      ...bucket,
    };
    if (registered) cdnr.push(row);
    else if (!intra && overThreshold(cn.original.totalPaise, opts)) cdnur.push({ ...row, urType: "B2CL" });
    else addB2cs(cn.placeOfSupply, !intra, bucket, -1);
  }

  // Table 13: every document dated in the period, cancelled ones counted.
  const docs: Gstr1DocRow[] = [];
  const docRow = (nature: Gstr1DocRow["nature"], docNum: number, list: ReadonlyArray<{ number: string; cancelled: boolean }>) => {
    if (!list.length) return;
    const sorted = [...list].sort((a, b) => naturalCompare(a.number, b.number));
    docs.push({ nature, docNum, from: sorted[0].number, to: sorted[sorted.length - 1].number, total: sorted.length, cancelled: sorted.filter((d) => d.cancelled).length });
  };
  docRow("Invoices for outward supply", 1, input.invoices.filter((i) => i.kind === "tax_invoice"));
  docRow("Debit Note", 4, input.invoices.filter((i) => i.kind === "debit_note"));
  docRow("Credit Note", 5, input.creditNotes.map((c) => ({ number: c.number, cancelled: false })));

  b2b.sort((a, b) => a.gstin.localeCompare(b.gstin) || naturalCompare(a.invoiceNumber, b.invoiceNumber) || a.ratePercent - b.ratePercent);
  b2cl.sort((a, b) => naturalCompare(a.invoiceNumber, b.invoiceNumber) || a.ratePercent - b.ratePercent);
  const notesOrder = (a: Gstr1NoteRow, b: Gstr1NoteRow) => (a.gstin ?? "").localeCompare(b.gstin ?? "") || naturalCompare(a.noteNumber, b.noteNumber) || a.ratePercent - b.ratePercent;
  cdnr.sort(notesOrder);
  cdnur.sort(notesOrder);
  const b2cs = [...b2csMap.values()].filter((r) => r.taxablePaise !== 0 || r.igstPaise !== 0 || r.cgstPaise !== 0 || r.sgstPaise !== 0).sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.ratePercent - b.ratePercent);
  const hsnRows = (m: Map<string, Gstr1HsnRow>) => [...m.values()].filter((r) => r.taxablePaise !== 0 || r.totalValuePaise !== 0).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.ratePercent - b.ratePercent);
  const hsnB2b = hsnRows(hsn.b2b);
  const hsnB2c = hsnRows(hsn.b2c);

  const totals = [...hsnB2b, ...hsnB2c].reduce(
    (t, r) => ({ ...t, taxablePaise: t.taxablePaise + r.taxablePaise, igstPaise: t.igstPaise + r.igstPaise, cgstPaise: t.cgstPaise + r.cgstPaise, sgstPaise: t.sgstPaise + r.sgstPaise }),
    { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, invoices, notes },
  );

  return {
    b2b,
    b2cl,
    b2cs,
    cdnr,
    cdnur,
    exempt: [...exempt.values()].filter((r) => r.nilRatedPaise || r.exemptedPaise || r.nonGstPaise),
    hsnB2b,
    hsnB2c,
    docs,
    totals,
  };
}

// -------------------------------------------------------------------------------------------------
// Formats
// -------------------------------------------------------------------------------------------------

/** `05-Oct-2026`: the offline tool's Excel date. */
export function gstr1ExcelDate(date: DateString): string {
  if (!isDateString(date)) throw new RangeError(`Not a date: ${date}`);
  return `${date.slice(8, 10)}-${MONTH_ABBR[Number(date.slice(5, 7)) - 1]}-${date.slice(0, 4)}`;
}

/** `05-10-2026`: the GSTR-1 JSON date. */
export function gstr1JsonDate(date: DateString): string {
  if (!isDateString(date)) throw new RangeError(`Not a date: ${date}`);
  return `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
}

/** `29-Karnataka`: the offline tool's place of supply. */
export function gstr1Pos(code: string): string {
  return `${code}-${stateName(code) ?? "Unknown"}`;
}

const r2 = (paise: Paise) => fromPaise(paise);

export type SheetSpec = {
  /** The offline tool's sheet name. */
  name: string;
  /** Row 1 of the sheet: "Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)". */
  title: string;
  /** Rows 2 and 3: the summary labels and their values (columns line up with the headers). */
  summary: Array<{ column: number; label: string; value: number }>;
  headers: string[];
  rows: Array<Array<string | number>>;
  /** Columns holding rupees, formatted 0.00. */
  moneyColumns: number[];
};

/** The workbook, sheet by sheet, in the offline tool's layout (summary rows 1–3, headings on row 4). */
export function gstr1Sheets(g: Gstr1Return): SheetSpec[] {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const uniq = (xs: string[]) => new Set(xs).size;
  return [
    {
      name: "b2b, sez, de",
      title: "Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)",
      summary: [
        { column: 0, label: "No. of Recipients", value: uniq(g.b2b.map((r) => r.gstin)) },
        { column: 2, label: "No. of Invoices", value: uniq(g.b2b.map((r) => r.invoiceNumber)) },
        { column: 4, label: "Total Invoice Value", value: r2(sum([...new Map(g.b2b.map((r) => [r.invoiceNumber, r.invoiceValuePaise])).values()])) },
        { column: 11, label: "Total Taxable Value", value: r2(sum(g.b2b.map((r) => r.taxablePaise))) },
        { column: 12, label: "Total Cess", value: 0 },
      ],
      headers: ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
      rows: g.b2b.map((r) => [r.gstin, r.receiverName, r.invoiceNumber, gstr1ExcelDate(r.invoiceDate), r2(r.invoiceValuePaise), gstr1Pos(r.placeOfSupply), r.reverseCharge ? "Y" : "N", "", "Regular B2B", "", r.ratePercent, r2(r.taxablePaise), 0]),
      moneyColumns: [4, 11, 12],
    },
    {
      name: "b2cl",
      title: "Summary For B2CL(5)",
      summary: [
        { column: 0, label: "No. of Invoices", value: uniq(g.b2cl.map((r) => r.invoiceNumber)) },
        { column: 2, label: "Total Inv Value", value: r2(sum([...new Map(g.b2cl.map((r) => [r.invoiceNumber, r.invoiceValuePaise])).values()])) },
        { column: 6, label: "Total Taxable Value", value: r2(sum(g.b2cl.map((r) => r.taxablePaise))) },
        { column: 7, label: "Total Cess", value: 0 },
      ],
      headers: ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
      rows: g.b2cl.map((r) => [r.invoiceNumber, gstr1ExcelDate(r.invoiceDate), r2(r.invoiceValuePaise), gstr1Pos(r.placeOfSupply), "", r.ratePercent, r2(r.taxablePaise), 0, ""]),
      moneyColumns: [2, 6, 7],
    },
    {
      name: "b2cs",
      title: "Summary For B2CS(7)",
      summary: [
        { column: 4, label: "Total Taxable  Value", value: r2(sum(g.b2cs.map((r) => r.taxablePaise))) },
        { column: 5, label: "Total Cess", value: 0 },
      ],
      headers: ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
      rows: g.b2cs.map((r) => ["OE", gstr1Pos(r.placeOfSupply), "", r.ratePercent, r2(r.taxablePaise), 0, ""]),
      moneyColumns: [4, 5],
    },
    {
      name: "cdnr",
      title: "Summary For CDNR(9B)",
      summary: [
        { column: 0, label: "No. of Recipients", value: uniq(g.cdnr.map((r) => r.gstin ?? "")) },
        { column: 2, label: "No. of Notes", value: uniq(g.cdnr.map((r) => r.noteNumber)) },
        { column: 8, label: "Total Note Value", value: r2(sum([...new Map(g.cdnr.map((r) => [r.noteNumber, r.noteValuePaise])).values()])) },
        { column: 11, label: "Total Taxable Value", value: r2(sum(g.cdnr.map((r) => r.taxablePaise))) },
        { column: 12, label: "Total Cess", value: 0 },
      ],
      headers: ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
      rows: g.cdnr.map((r) => [r.gstin ?? "", r.receiverName, r.noteNumber, gstr1ExcelDate(r.noteDate), r.noteType, gstr1Pos(r.placeOfSupply), r.reverseCharge ? "Y" : "N", "Regular B2B", r2(r.noteValuePaise), "", r.ratePercent, r2(r.taxablePaise), 0]),
      moneyColumns: [8, 11, 12],
    },
    {
      name: "cdnur",
      title: "Summary For CDNUR(9B)",
      summary: [
        { column: 1, label: "No. of Notes/Vouchers", value: uniq(g.cdnur.map((r) => r.noteNumber)) },
        { column: 5, label: "Total Note Value", value: r2(sum([...new Map(g.cdnur.map((r) => [r.noteNumber, r.noteValuePaise])).values()])) },
        { column: 8, label: "Total Taxable Value", value: r2(sum(g.cdnur.map((r) => r.taxablePaise))) },
        { column: 9, label: "Total Cess", value: 0 },
      ],
      headers: ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
      rows: g.cdnur.map((r) => [r.urType ?? "B2CL", r.noteNumber, gstr1ExcelDate(r.noteDate), r.noteType, gstr1Pos(r.placeOfSupply), r2(r.noteValuePaise), "", r.ratePercent, r2(r.taxablePaise), 0]),
      moneyColumns: [5, 8, 9],
    },
    {
      name: "exemp",
      title: "Summary For Nil rated, exempted and non GST outward supplies (8)",
      summary: [
        { column: 1, label: "Total Nil Rated Supplies", value: r2(sum(g.exempt.map((r) => r.nilRatedPaise))) },
        { column: 2, label: "Total Exempted Supplies", value: r2(sum(g.exempt.map((r) => r.exemptedPaise))) },
        { column: 3, label: "Total Non-GST Supplies", value: r2(sum(g.exempt.map((r) => r.nonGstPaise))) },
      ],
      headers: ["Description", "Nil Rated Supplies", "Exempted(other than nil rated/non GST supply)", "Non-GST Supplies"],
      rows: g.exempt.map((r) => [r.description, r2(r.nilRatedPaise), r2(r.exemptedPaise), r2(r.nonGstPaise)]),
      moneyColumns: [1, 2, 3],
    },
    hsnSheet("hsn(b2b)", "Summary For HSN(12) - B2B", g.hsnB2b),
    hsnSheet("hsn(b2c)", "Summary For HSN(12) - B2C", g.hsnB2c),
    {
      name: "docs",
      title: "Summary of documents issued during the tax period (13)",
      summary: [
        { column: 3, label: "Total Number", value: sum(g.docs.map((d) => d.total)) },
        { column: 4, label: "Total Cancelled", value: sum(g.docs.map((d) => d.cancelled)) },
      ],
      headers: ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"],
      rows: g.docs.map((d) => [d.nature, d.from, d.to, d.total, d.cancelled]),
      moneyColumns: [],
    },
  ];
}

function hsnSheet(name: string, title: string, rows: readonly Gstr1HsnRow[]): SheetSpec {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    name,
    title,
    summary: [
      { column: 0, label: "No. of HSN", value: new Set(rows.map((r) => r.hsn)).size },
      { column: 4, label: "Total Value", value: r2(sum(rows.map((r) => r.totalValuePaise))) },
      { column: 6, label: "Total Taxable Value", value: r2(sum(rows.map((r) => r.taxablePaise))) },
      { column: 7, label: "Total Integrated Tax", value: r2(sum(rows.map((r) => r.igstPaise))) },
      { column: 8, label: "Total Central Tax", value: r2(sum(rows.map((r) => r.cgstPaise))) },
      { column: 9, label: "Total State/UT Tax", value: r2(sum(rows.map((r) => r.sgstPaise))) },
      { column: 10, label: "Total Cess", value: 0 },
    ],
    headers: ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
    rows: rows.map((r) => [r.hsn, r.description, r.uqc, r.quantity, r2(r.totalValuePaise), r.ratePercent, r2(r.taxablePaise), r2(r.igstPaise), r2(r.cgstPaise), r2(r.sgstPaise), 0]),
    moneyColumns: [4, 6, 7, 8, 9, 10],
  };
}

/**
 * The GSTR-1 JSON for upload: `{ gstin, fp, version, hash, b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn,
 * doc_issue }`, each table present only when it has rows. [verify `version` against the offline
 * tool in use]
 */
export function gstr1Json(g: Gstr1Return, meta: { gstin: string; fp: string }): Record<string, unknown> {
  const itm = (b: RateBucket, i: number, withIntra = true) => ({
    num: i + 1,
    itm_det: withIntra
      ? { txval: r2(b.taxablePaise), rt: b.ratePercent, iamt: r2(b.igstPaise), camt: r2(b.cgstPaise), samt: r2(b.sgstPaise), csamt: 0 }
      : { txval: r2(b.taxablePaise), rt: b.ratePercent, iamt: r2(b.igstPaise), csamt: 0 },
  });
  const out: Record<string, unknown> = { gstin: meta.gstin, fp: meta.fp, version: "GST3.1.6", hash: "hash" };

  if (g.b2b.length) {
    const byCtin = new Map<string, Map<string, Gstr1B2bRow[]>>();
    for (const r of g.b2b) {
      const invs = byCtin.get(r.gstin) ?? new Map<string, Gstr1B2bRow[]>();
      invs.set(r.invoiceNumber, [...(invs.get(r.invoiceNumber) ?? []), r]);
      byCtin.set(r.gstin, invs);
    }
    out.b2b = [...byCtin.entries()].map(([ctin, invs]) => ({
      ctin,
      inv: [...invs.values()].map((rows) => ({
        inum: rows[0].invoiceNumber,
        idt: gstr1JsonDate(rows[0].invoiceDate),
        val: r2(rows[0].invoiceValuePaise),
        pos: rows[0].placeOfSupply,
        rchrg: rows[0].reverseCharge ? "Y" : "N",
        inv_typ: "R",
        itms: rows.map((b, i) => itm(b, i)),
      })),
    }));
  }
  if (g.b2cl.length) {
    const byPos = new Map<string, Map<string, Gstr1B2clRow[]>>();
    for (const r of g.b2cl) {
      const invs = byPos.get(r.placeOfSupply) ?? new Map<string, Gstr1B2clRow[]>();
      invs.set(r.invoiceNumber, [...(invs.get(r.invoiceNumber) ?? []), r]);
      byPos.set(r.placeOfSupply, invs);
    }
    out.b2cl = [...byPos.entries()].map(([pos, invs]) => ({
      pos,
      inv: [...invs.values()].map((rows) => ({
        inum: rows[0].invoiceNumber,
        idt: gstr1JsonDate(rows[0].invoiceDate),
        val: r2(rows[0].invoiceValuePaise),
        itms: rows.map((b, i) => itm({ ...b, cgstPaise: 0, sgstPaise: 0 }, i, false)),
      })),
    }));
  }
  if (g.b2cs.length) {
    out.b2cs = g.b2cs.map((r) => ({
      sply_ty: r.supplyType,
      rt: r.ratePercent,
      typ: "OE",
      pos: r.placeOfSupply,
      txval: r2(r.taxablePaise),
      ...(r.supplyType === "INTER" ? { iamt: r2(r.igstPaise) } : { camt: r2(r.cgstPaise), samt: r2(r.sgstPaise) }),
      csamt: 0,
    }));
  }
  const notesJson = (rows: readonly Gstr1NoteRow[]) => {
    const byNote = new Map<string, Gstr1NoteRow[]>();
    for (const r of rows) byNote.set(r.noteNumber, [...(byNote.get(r.noteNumber) ?? []), r]);
    return [...byNote.values()];
  };
  if (g.cdnr.length) {
    const byCtin = new Map<string, Gstr1NoteRow[][]>();
    for (const n of notesJson(g.cdnr)) byCtin.set(n[0].gstin ?? "", [...(byCtin.get(n[0].gstin ?? "") ?? []), n]);
    out.cdnr = [...byCtin.entries()].map(([ctin, nts]) => ({
      ctin,
      nt: nts.map((rows) => ({
        ntty: rows[0].noteType,
        nt_num: rows[0].noteNumber,
        nt_dt: gstr1JsonDate(rows[0].noteDate),
        val: r2(rows[0].noteValuePaise),
        pos: rows[0].placeOfSupply,
        rchrg: rows[0].reverseCharge ? "Y" : "N",
        inv_typ: "R",
        itms: rows.map((b, i) => itm(b, i)),
      })),
    }));
  }
  if (g.cdnur.length) {
    out.cdnur = notesJson(g.cdnur).map((rows) => ({
      typ: rows[0].urType ?? "B2CL",
      ntty: rows[0].noteType,
      nt_num: rows[0].noteNumber,
      nt_dt: gstr1JsonDate(rows[0].noteDate),
      val: r2(rows[0].noteValuePaise),
      pos: rows[0].placeOfSupply,
      itms: rows.map((b, i) => itm(b, i, false)),
    }));
  }
  if (g.exempt.length) {
    const code: Record<ExemptCategory, string> = {
      "Inter-State supplies to registered persons": "INTRB2B",
      "Intra-State supplies to registered persons": "INTRAB2B",
      "Inter-State supplies to unregistered persons": "INTRB2C",
      "Intra-State supplies to unregistered persons": "INTRAB2C",
    };
    out.nil = { inv: g.exempt.map((r) => ({ sply_ty: code[r.description], nil_amt: r2(r.nilRatedPaise), expt_amt: r2(r.exemptedPaise), ngsup_amt: r2(r.nonGstPaise) })) };
  }
  const hsnJson = (rows: readonly Gstr1HsnRow[]) =>
    rows.map((r, i) => ({ num: i + 1, hsn_sc: r.hsn, desc: r.description, uqc: r.uqc, qty: r.quantity, rt: r.ratePercent, txval: r2(r.taxablePaise), iamt: r2(r.igstPaise), camt: r2(r.cgstPaise), samt: r2(r.sgstPaise), csamt: 0 }));
  if (g.hsnB2b.length || g.hsnB2c.length) {
    out.hsn = { ...(g.hsnB2b.length ? { hsn_b2b: hsnJson(g.hsnB2b) } : {}), ...(g.hsnB2c.length ? { hsn_b2c: hsnJson(g.hsnB2c) } : {}) };
  }
  if (g.docs.length) {
    out.doc_issue = {
      doc_det: g.docs.map((d) => ({ doc_num: d.docNum, doc_typ: d.nature, docs: [{ num: 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.total - d.cancelled }] })),
    };
  }
  return out;
}

/** True when the period lies in one FY and isn't in the future. */
export function gstr1PeriodProblem(period: Gstr1Period, today: DateString): string | null {
  if (financialYearOf(period.from) !== financialYearOf(period.to)) return "Choose a month or a quarter within one financial year.";
  if (compareDates(period.from, today) > 0) return "That period hasn't started yet.";
  return null;
}
