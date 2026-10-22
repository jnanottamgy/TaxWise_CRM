/**
 * GST reconciliation engine: GSTR-2B / IMS ↔ purchase register (§6.12, §7.8.1).
 *
 * Matching runs per supplier GSTIN, and within a supplier keeps debit documents (invoices, debit
 * notes, ISD invoices, bills of entry) apart from credit documents (credit notes), in three tiers:
 *   1. **Exact:** trimmed, upper-cased document number.
 *   2. **Loose:** letters and digits only, numeric runs de-zero-padded (`INV/007` ≡ `inv-7`).
 *   3. **Fuzzy:** same supplier, taxable value within ±₹1 or 0.5%, dates within 5 days.
 * A matched pair within ₹1 on every tax head is *Matched*; otherwise *Mismatch*, with signed deltas
 * per head (2B − books). Leftovers are *missing in books* (in 2B, not booked: unclaimed ITC) and
 * *missing in 2B* (booked, supplier hasn't reported: ITC at risk).
 *
 * Outputs: the entries (one per pair or leftover, shaped for `gst_recon_entries`), a summary for
 * `gst_recon_runs.summary`, the supplier roll-up (whom to chase), the IMS action list, warnings
 * (the 2B file's GSTIN against the client's), and a carry-forward helper that compares this month's
 * run with last month's open items.
 *
 * The tolerances are the spec's numbers, passed in as `ReconParams` (`RECON_DEFAULTS` holds §6.12's
 * values). Pure and client-safe; amounts are integer paise.
 */

import { diffDays, MONTH_ABBR, parseDateString, type DateString } from "@/lib/domain/fy";
import {
  AMOUNT_FIELD_LABELS,
  AMOUNT_FIELDS,
  GST_DOC_TYPE_LABELS,
  isCreditDoc,
  normaliseGstinText,
  periodLabelOf,
  TAX_HEADS,
  totalTax,
  type DocAmounts,
  type GstDocRow,
  type GstDocType,
  type Gstr2bSection,
} from "@/lib/domain/gstr2b";
import { formatINR, fromPaise, percentOf, type Paise } from "@/lib/domain/money";

// -------------------------------------------------------------------------------------------------
// Parameters and vocabulary
// -------------------------------------------------------------------------------------------------

export type ReconParams = {
  /** A pair is Matched when every tax head is within this (§6.12: ₹1). */
  headTolerancePaise: Paise;
  /** Fuzzy tier: taxable values within this absolute amount … (§6.12: ±₹1) */
  fuzzyTaxableTolerancePaise: Paise;
  /** … or within this percentage of the larger of the two (§6.12: 0.5%). */
  fuzzyTaxablePercent: number | string;
  /** Fuzzy tier: document dates within this many days (§6.12: 5). */
  fuzzyDateWindowDays: number;
  /** The 2B sections the IMS acts on (§6.7: inward invoices, debit and credit notes). */
  imsSections: readonly Gstr2bSection[];
};

/** §6.12's values. */
export const RECON_DEFAULTS: ReconParams = {
  headTolerancePaise: 100,
  fuzzyTaxableTolerancePaise: 100,
  fuzzyTaxablePercent: "0.5",
  fuzzyDateWindowDays: 5,
  imsSections: ["b2b", "b2ba", "cdnr", "cdnra"],
};

export const RECON_BUCKETS = ["matched", "mismatch", "missing_in_books", "missing_in_2b"] as const;
export type ReconBucket = (typeof RECON_BUCKETS)[number];

export const RECON_BUCKET_LABELS: Record<ReconBucket, string> = {
  matched: "Matched",
  mismatch: "Mismatch",
  missing_in_books: "In 2B, not in books",
  missing_in_2b: "In books, not in 2B",
};

export const MATCH_TIERS = ["exact", "loose", "fuzzy"] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export const MATCH_TIER_LABELS: Record<MatchTier, string> = {
  exact: "Exact document number",
  loose: "Document number (format differs)",
  fuzzy: "Amount and date",
};

/** `gst_recon_entries.resolution` (§5.10). */
export const RECON_RESOLUTIONS = ["open", "accepted", "follow_up_supplier", "ignore"] as const;
export type ReconResolution = (typeof RECON_RESOLUTIONS)[number];

export const IMS_ACTIONS = ["accept", "reject", "keep_pending"] as const;
export type ImsAction = (typeof IMS_ACTIONS)[number];

export const IMS_ACTION_LABELS: Record<ImsAction, string> = {
  accept: "Accept",
  reject: "Reject",
  keep_pending: "Keep pending",
};

/** §6.7: on the IMS, a document with no action is deemed accepted. */
export const IMS_DEEMED_ACCEPTANCE_NOTE =
  "Documents left without an action on the IMS are deemed accepted, and GSTR-2B is regenerated after IMS actions.";

// -------------------------------------------------------------------------------------------------
// Document-number keys and tolerances
// -------------------------------------------------------------------------------------------------

/** Tier 1 key (§6.12): the document number trimmed and upper-cased. */
export function exactDocKey(docNumber: string): string {
  return docNumber.trim().toUpperCase();
}

/**
 * Tier 2 key (§6.12): numeric runs de-zero-padded, then letters and digits only, upper-cased:
 * `INV/007` → `INV7`, `inv-7` → `INV7`, `2026/INV/0010` → `2026INV10`.
 */
export function looseDocKey(docNumber: string): string {
  return docNumber
    .toUpperCase()
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""))
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Tier 3 amount test (§6.12): taxable values within ±₹1, or within 0.5% of the larger of the two
 * (half-up to the paisa), whichever is wider.
 */
export function taxableWithinFuzzyTolerance(a: Paise, b: Paise, params: Pick<ReconParams, "fuzzyTaxableTolerancePaise" | "fuzzyTaxablePercent"> = RECON_DEFAULTS): boolean {
  const diff = Math.abs(a - b);
  const base = Math.max(Math.abs(a), Math.abs(b));
  const tolerance = Math.max(params.fuzzyTaxableTolerancePaise, percentOf(base, params.fuzzyTaxablePercent));
  return diff <= tolerance;
}

/** Tier 3 date test (§6.12): both dates known and at most `days` apart. */
export function datesWithin(a: DateString | null, b: DateString | null, days: number): boolean {
  if (!a || !b) return false;
  return Math.abs(diffDays(a, b)) <= days;
}

/** Signed differences, 2B − books, for the taxable value and every tax head. */
export function amountDeltas(portal: DocAmounts, books: DocAmounts): DocAmounts {
  const out = {} as DocAmounts;
  for (const f of AMOUNT_FIELDS) out[f] = portal[f] - books[f];
  return out;
}

/** True when every tax head of the deltas is within the tolerance (§6.12: "within ₹1 on every tax head"). */
export function headsWithinTolerance(deltas: DocAmounts, tolerancePaise: Paise = RECON_DEFAULTS.headTolerancePaise): boolean {
  return TAX_HEADS.every((h) => Math.abs(deltas[h]) <= tolerancePaise);
}

// -------------------------------------------------------------------------------------------------
// Matching
// -------------------------------------------------------------------------------------------------

export type MatchPair = { portal: number; books: number; tier: MatchTier };

export type MatchOutcome = {
  pairs: MatchPair[];
  /** Indexes into the portal list that found no partner. */
  unmatchedPortal: number[];
  /** Indexes into the books list that found no partner. */
  unmatchedBooks: number[];
};

function matchClass(docType: GstDocType): "credit" | "debit" {
  return isCreditDoc(docType) ? "credit" : "debit";
}

function groupKey(row: GstDocRow): string {
  return `${normaliseGstinText(row.supplierGstin)}|${matchClass(row.docType)}`;
}

type Candidate = { p: number; b: number; dateGap: number; amountGap: number };

function byCloseness(x: Candidate, y: Candidate): number {
  return x.dateGap - y.dateGap || x.amountGap - y.amountGap || x.p - y.p || x.b - y.b;
}

function dateGap(a: DateString | null, b: DateString | null): number {
  return a && b ? Math.abs(diffDays(a, b)) : Number.MAX_SAFE_INTEGER;
}

/** Pairs the closest candidates first; each document is used at most once. */
function assign(candidates: Candidate[], usedP: Set<number>, usedB: Set<number>, tier: MatchTier, pairs: MatchPair[]) {
  candidates.sort(byCloseness);
  for (const c of candidates) {
    if (usedP.has(c.p) || usedB.has(c.b)) continue;
    usedP.add(c.p);
    usedB.add(c.b);
    pairs.push({ portal: c.p, books: c.b, tier });
  }
}

/**
 * Matches 2B documents with book documents (§6.12), per supplier GSTIN and document class, tier by
 * tier: exact number, loose number, then fuzzy (amount and date). Within a tier the closest pair
 * (date, then taxable value) wins, so duplicates pair up deterministically.
 */
export function matchDocuments(portal: readonly GstDocRow[], books: readonly GstDocRow[], params: ReconParams = RECON_DEFAULTS): MatchOutcome {
  const pairs: MatchPair[] = [];
  const usedP = new Set<number>();
  const usedB = new Set<number>();

  const groups = new Map<string, { p: number[]; b: number[] }>();
  const groupFor = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { p: [], b: [] };
      groups.set(key, g);
    }
    return g;
  };
  portal.forEach((row, i) => groupFor(groupKey(row)).p.push(i));
  books.forEach((row, i) => groupFor(groupKey(row)).b.push(i));

  const tiers: Array<{ tier: MatchTier; key: (row: GstDocRow) => string }> = [
    { tier: "exact", key: (r) => exactDocKey(r.docNumber) },
    { tier: "loose", key: (r) => looseDocKey(r.docNumber) },
  ];

  for (const g of groups.values()) {
    if (g.p.length === 0 || g.b.length === 0) continue;
    for (const { tier, key } of tiers) {
      const bookByKey = new Map<string, number[]>();
      for (const b of g.b) {
        if (usedB.has(b)) continue;
        const k = key(books[b]);
        if (k === "") continue;
        const list = bookByKey.get(k) ?? [];
        list.push(b);
        bookByKey.set(k, list);
      }
      const candidates: Candidate[] = [];
      for (const p of g.p) {
        if (usedP.has(p)) continue;
        const k = key(portal[p]);
        if (k === "") continue;
        for (const b of bookByKey.get(k) ?? []) {
          candidates.push({ p, b, dateGap: dateGap(portal[p].docDate, books[b].docDate), amountGap: Math.abs(portal[p].taxable - books[b].taxable) });
        }
      }
      assign(candidates, usedP, usedB, tier, pairs);
    }

    const fuzzy: Candidate[] = [];
    for (const p of g.p) {
      if (usedP.has(p)) continue;
      for (const b of g.b) {
        if (usedB.has(b)) continue;
        const pr = portal[p];
        const br = books[b];
        if (!datesWithin(pr.docDate, br.docDate, params.fuzzyDateWindowDays)) continue;
        if (!taxableWithinFuzzyTolerance(pr.taxable, br.taxable, params)) continue;
        fuzzy.push({ p, b, dateGap: dateGap(pr.docDate, br.docDate), amountGap: Math.abs(pr.taxable - br.taxable) });
      }
    }
    assign(fuzzy, usedP, usedB, "fuzzy", pairs);
  }

  return {
    pairs,
    unmatchedPortal: portal.map((_, i) => i).filter((i) => !usedP.has(i)),
    unmatchedBooks: books.map((_, i) => i).filter((i) => !usedB.has(i)),
  };
}

// -------------------------------------------------------------------------------------------------
// Entries
// -------------------------------------------------------------------------------------------------

/** One reconciliation line (§5.10 `gst_recon_entries`): a pair, or a leftover from one side. */
export type ReconEntry = {
  /** Stable within a run: supplier, class and loose document number (`#2` for duplicates). */
  key: string;
  bucket: ReconBucket;
  tier: MatchTier | null;
  supplierGstin: string;
  supplierName: string | null;
  portal: GstDocRow | null;
  books: GstDocRow | null;
  /** 2B − books, per head; null for leftovers. */
  deltas: DocAmounts | null;
  /** Days between the two document dates (2B − books); null when either is unknown or a leftover. */
  dateDeltaDays: number | null;
  /** ITC on each side (IGST + CGST + SGST + cess, signed). */
  itc: { portal: Paise; books: Paise };
  /** Plain-English explanations, shown under the row. */
  notes: string[];
};

const DAY_MONTH = (d: DateString) => {
  const { year, month, day } = parseDateString(d);
  return `${String(day).padStart(2, "0")} ${MONTH_ABBR[month - 1]} ${year}`;
};

/** `05 Sep 2026`, or "no date". */
export function formatDocDate(date: DateString | null): string {
  return date ? DAY_MONTH(date) : "no date";
}

function headSwapNote(portal: DocAmounts, books: DocAmounts, tolerance: Paise): string | null {
  const pLocal = portal.cgst + portal.sgst;
  const bLocal = books.cgst + books.sgst;
  if (portal.igst !== 0 && books.igst === 0 && bLocal !== 0 && pLocal === 0 && Math.abs(portal.igst - bLocal) <= 2 * tolerance) {
    return "Charged as IGST in 2B but as CGST + SGST in the books: check the place of supply with the supplier.";
  }
  if (books.igst !== 0 && portal.igst === 0 && pLocal !== 0 && bLocal === 0 && Math.abs(books.igst - pLocal) <= 2 * tolerance) {
    return "Charged as CGST + SGST in 2B but as IGST in the books: check the place of supply with the supplier.";
  }
  return null;
}

function pairNotes(portal: GstDocRow, books: GstDocRow, tier: MatchTier, deltas: DocAmounts, matched: boolean, params: ReconParams): string[] {
  const notes: string[] = [];
  if (tier === "loose") notes.push(`Document numbers are written differently: 2B “${portal.docNumber}”, books “${books.docNumber}”.`);
  if (tier === "fuzzy") {
    notes.push(`Matched on amount and date; the document numbers differ: 2B “${portal.docNumber}”, books “${books.docNumber}”.`);
  }
  if (portal.docDate && books.docDate && portal.docDate !== books.docDate) {
    notes.push(`Dates differ: 2B ${formatDocDate(portal.docDate)}, books ${formatDocDate(books.docDate)}.`);
  }
  if (!matched) {
    const swap = headSwapNote(portal, books, params.headTolerancePaise);
    if (swap) notes.push(swap);
    for (const h of TAX_HEADS) {
      const d = deltas[h];
      if (Math.abs(d) <= params.headTolerancePaise) continue;
      notes.push(
        `${AMOUNT_FIELD_LABELS[h]}: 2B ${formatINR(portal[h])}, books ${formatINR(books[h])} (${d > 0 ? "2B" : "books"} ${formatINR(Math.abs(d))} more).`,
      );
    }
  }
  if (Math.abs(deltas.taxable) > params.headTolerancePaise) {
    notes.push(`Taxable value: 2B ${formatINR(portal.taxable)}, books ${formatINR(books.taxable)}.`);
  }
  return notes;
}

function leftoverNotes(row: GstDocRow, bucket: "missing_in_books" | "missing_in_2b"): string[] {
  const credit = isCreditDoc(row.docType);
  const tax = formatINR(Math.abs(totalTax(row)));
  const notes: string[] = [];
  if (bucket === "missing_in_books") {
    notes.push(
      credit
        ? `${GST_DOC_TYPE_LABELS[row.docType]} in GSTR-2B but not in the books: once it is booked and accepted, ITC goes down by ${tax}.`
        : "In GSTR-2B but not in the purchase register (unclaimed ITC): book it, or reject it on the IMS if it isn't the client's purchase.",
    );
    if (row.itcAvailable === false) notes.push(`2B marks this ITC as not available${row.itcUnavailableReason ? ` (${row.itcUnavailableReason})` : ""}.`);
    if (row.reverseCharge) notes.push("Reverse charge: the client pays this tax in cash before taking the credit.");
  } else {
    notes.push(
      credit
        ? `${GST_DOC_TYPE_LABELS[row.docType]} in the books but not yet in GSTR-2B: the supplier hasn't reported it.`
        : "In the books but not in GSTR-2B (ITC at risk): the supplier hasn't reported it yet. Follow up with the supplier.",
    );
  }
  return notes;
}

// -------------------------------------------------------------------------------------------------
// Summary, roll-up, IMS
// -------------------------------------------------------------------------------------------------

export type BucketTotals = {
  count: number;
  /** Sums of the 2B side (taxable and heads). */
  portal: DocAmounts;
  /** Sums of the books side. */
  books: DocAmounts;
  portalItc: Paise;
  booksItc: Paise;
};

export type ReconSummary = {
  buckets: Record<ReconBucket, BucketTotals>;
  /** Pairs per tier. */
  byTier: Record<MatchTier, number>;
  documents: { portal: number; books: number };
  itc: {
    /** ITC per GSTR-2B: every 2B document except those 2B marks as "ITC not available". */
    per2b: Paise;
    /** ITC on 2B documents marked "ITC not available". */
    notAvailablePer2b: Paise;
    /** ITC per the purchase register. */
    perBooks: Paise;
    /** Books ITC on matched pairs. */
    matched: Paise;
    /** Books ITC on mismatched pairs. */
    mismatched: Paise;
    /** 2B − books ITC over the mismatched pairs (signed). */
    mismatchDifference: Paise;
    /** In 2B, not in the books: invoices and debit notes with ITC available (book or reject). */
    unclaimed: Paise;
    /** Credit notes in 2B not yet in the books: ITC that will have to be reversed (a positive number). */
    reversalPending: Paise;
    /** In the books, not in 2B (invoices and debit notes), plus books ITC above 2B on mismatched pairs. */
    atRisk: Paise;
    atRiskMissingIn2b: Paise;
    atRiskExcessOverTwoB: Paise;
    /** "ITC available" (§6.12): what GSTR-2B makes available, i.e. `per2b`. */
    available: Paise;
  };
};

export type SupplierRollup = {
  supplierGstin: string;
  supplierName: string | null;
  counts: Record<ReconBucket, number>;
  /** Books ITC missing from 2B plus books ITC above 2B on mismatches: the value to chase. */
  itcAtRisk: Paise;
  /** 2B ITC not yet booked. */
  unclaimedItc: Paise;
  /** 2B − books ITC over this supplier's mismatches. */
  mismatchDifference: Paise;
  /** Book documents the supplier hasn't reported (list these in the follow-up). */
  missingIn2b: GstDocRow[];
  mismatches: ReconEntry[];
  missingInBooks: GstDocRow[];
  /** True when there is something to ask the supplier about. */
  chase: boolean;
};

export type ImsItem = {
  entryKey: string;
  section: Gstr2bSection;
  supplierGstin: string;
  supplierName: string | null;
  docType: GstDocType;
  docNumber: string;
  docDate: DateString | null;
  itc: Paise;
  action: ImsAction;
  reason: string;
};

export type ReconWarningCode = "gstin_mismatch" | "no_client_gstin" | "no_portal_gstin" | "duplicate_in_books" | "duplicate_in_2b";

export type ReconWarning = { code: ReconWarningCode; message: string; supplierGstin: string | null; docNumber: string | null };

export type ReconResult = {
  entries: ReconEntry[];
  summary: ReconSummary;
  suppliers: SupplierRollup[];
  ims: ImsItem[];
  warnings: ReconWarning[];
  params: ReconParams;
};

function zeroAmounts(): DocAmounts {
  return { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
}

function addInto(target: DocAmounts, row: DocAmounts | null) {
  if (!row) return;
  for (const f of AMOUNT_FIELDS) target[f] += row[f];
}

function emptyBucketTotals(): Record<ReconBucket, BucketTotals> {
  const out = {} as Record<ReconBucket, BucketTotals>;
  for (const b of RECON_BUCKETS) out[b] = { count: 0, portal: zeroAmounts(), books: zeroAmounts(), portalItc: 0, booksItc: 0 };
  return out;
}

function emptyCounts(): Record<ReconBucket, number> {
  const out = {} as Record<ReconBucket, number>;
  for (const b of RECON_BUCKETS) out[b] = 0;
  return out;
}

/**
 * The §6.12 GSTIN check: the 2B file's GSTIN must equal the client's. Returns the warning, or null
 * when they agree.
 */
export function checkPortalGstin(portalGstin: string | null | undefined, clientGstin: string | null | undefined): ReconWarning | null {
  const p = normaliseGstinText(portalGstin);
  const c = normaliseGstinText(clientGstin);
  const w = (code: ReconWarningCode, message: string): ReconWarning => ({ code, message, supplierGstin: null, docNumber: null });
  if (c === "") return w("no_client_gstin", "The client has no GSTIN on file, so the GSTR-2B file couldn't be checked against it.");
  if (p === "") return w("no_portal_gstin", "The GSTR-2B file doesn't say which GSTIN it is for. Check that it is this client's file.");
  if (p === c) return null;
  if (p.length === 15 && c.length === 15 && p.slice(2, 12) === c.slice(2, 12)) {
    return w(
      "gstin_mismatch",
      `The GSTR-2B file is for ${p}, another registration of the same PAN, but the client's GSTIN is ${c}. Check that you uploaded the file for the right state.`,
    );
  }
  return w("gstin_mismatch", `The GSTR-2B file is for ${p}, but the client's GSTIN is ${c}. Check that you uploaded this client's file.`);
}

function duplicateWarnings(rows: readonly GstDocRow[], side: "books" | "2b"): ReconWarning[] {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = `${groupKey(r)}|${looseDocKey(r.docNumber)}`;
    if (looseDocKey(r.docNumber) === "") continue;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const out: ReconWarning[] = [];
  const reported = new Set<string>();
  for (const r of rows) {
    const k = `${groupKey(r)}|${looseDocKey(r.docNumber)}`;
    if ((seen.get(k) ?? 0) < 2 || reported.has(k)) continue;
    reported.add(k);
    const n = seen.get(k) ?? 0;
    out.push({
      code: side === "books" ? "duplicate_in_books" : "duplicate_in_2b",
      message:
        side === "books"
          ? `${GST_DOC_TYPE_LABELS[r.docType]} ${r.docNumber} from ${r.supplierGstin || "an unregistered supplier"} is booked ${n} times: check for a double claim of ITC.`
          : `${GST_DOC_TYPE_LABELS[r.docType]} ${r.docNumber} from ${r.supplierGstin || "(no GSTIN)"} appears ${n} times in GSTR-2B.`,
      supplierGstin: r.supplierGstin,
      docNumber: r.docNumber,
    });
  }
  return out;
}

function entryKeyBase(row: GstDocRow): string {
  const loose = looseDocKey(row.docNumber);
  return `${normaliseGstinText(row.supplierGstin)}|${matchClass(row.docType)}|${loose || row.ref}`;
}

/** Plain code-unit order (deterministic on every machine, unlike `localeCompare`). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortEntries(a: ReconEntry, b: ReconEntry): number {
  const order = (e: ReconEntry) => RECON_BUCKETS.indexOf(e.bucket);
  const doc = (e: ReconEntry) => e.portal ?? e.books;
  const da = doc(a);
  const db = doc(b);
  return (
    cmp(a.supplierGstin, b.supplierGstin) ||
    order(a) - order(b) ||
    cmp(da?.docDate ?? "", db?.docDate ?? "") ||
    cmp(da?.docNumber ?? "", db?.docNumber ?? "")
  );
}

/** The suggested IMS action for one 2B document (§6.7, §6.12). Null for documents IMS doesn't cover. */
export function imsActionFor(entry: ReconEntry, params: Pick<ReconParams, "imsSections"> = RECON_DEFAULTS, duplicateOfMatched = false): ImsItem | null {
  const row = entry.portal;
  if (!row || row.section === "register") return null;
  if (!params.imsSections.includes(row.section) || row.reverseCharge) return null;
  let action: ImsAction;
  let reason: string;
  const credit = isCreditDoc(row.docType);
  switch (entry.bucket) {
    case "matched":
      action = "accept";
      reason =
        entry.tier === "exact"
          ? "Matches the purchase register."
          : entry.tier === "loose"
            ? "Matches the purchase register (document number written differently)."
            : "Matches the purchase register on amount and date (document number differs).";
      break;
    case "mismatch":
      action = "keep_pending";
      reason = `Differs from the purchase register (${entry.notes.filter((n) => /^(IGST|CGST|SGST|Cess|Charged)/.test(n)).join(" ") || "amounts differ"}). Confirm with the supplier; accept once settled, or reject if the supplier must issue a corrected document.`;
      break;
    case "missing_in_books":
      if (duplicateOfMatched) {
        action = "reject";
        reason = "The same document number from this supplier already matches the books; this looks like a duplicate.";
      } else {
        action = "keep_pending";
        reason = credit
          ? "Credit note not in the books. If it is valid, book it and accept it (ITC goes down); if not, reject it."
          : "Not in the purchase register. Ask the client: if it is their purchase, book it and accept it; if not, reject it.";
      }
      break;
    default:
      return null;
  }
  return {
    entryKey: entry.key,
    section: row.section,
    supplierGstin: row.supplierGstin,
    supplierName: row.supplierName,
    docType: row.docType,
    docNumber: row.docNumber,
    docDate: row.docDate,
    itc: totalTax(row),
    action,
    reason,
  };
}

/**
 * Reconciles GSTR-2B with the purchase register (§6.12). `clientGstin` is the client's GSTIN on
 * file; `portalGstin` is the GSTIN the 2B file says it is for (`parseGstr2b(...).gstin`).
 */
export function reconcile(
  portalRows: readonly GstDocRow[],
  bookRows: readonly GstDocRow[],
  opts: { clientGstin: string | null; portalGstin?: string | null; params?: Partial<ReconParams> },
): ReconResult {
  const params: ReconParams = { ...RECON_DEFAULTS, ...opts.params };
  const outcome = matchDocuments(portalRows, bookRows, params);
  const entries: ReconEntry[] = [];
  const keyCount = new Map<string, number>();
  const uniqueKey = (base: string) => {
    const n = (keyCount.get(base) ?? 0) + 1;
    keyCount.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };

  for (const pair of outcome.pairs) {
    const portal = portalRows[pair.portal];
    const books = bookRows[pair.books];
    const deltas = amountDeltas(portal, books);
    const matched = headsWithinTolerance(deltas, params.headTolerancePaise);
    entries.push({
      key: "",
      bucket: matched ? "matched" : "mismatch",
      tier: pair.tier,
      supplierGstin: normaliseGstinText(portal.supplierGstin),
      supplierName: portal.supplierName ?? books.supplierName,
      portal,
      books,
      deltas,
      dateDeltaDays: portal.docDate && books.docDate ? diffDays(portal.docDate, books.docDate) : null,
      itc: { portal: totalTax(portal), books: totalTax(books) },
      notes: pairNotes(portal, books, pair.tier, deltas, matched, params),
    });
  }
  for (const i of outcome.unmatchedPortal) {
    const row = portalRows[i];
    entries.push({
      key: "",
      bucket: "missing_in_books",
      tier: null,
      supplierGstin: normaliseGstinText(row.supplierGstin),
      supplierName: row.supplierName,
      portal: row,
      books: null,
      deltas: null,
      dateDeltaDays: null,
      itc: { portal: totalTax(row), books: 0 },
      notes: leftoverNotes(row, "missing_in_books"),
    });
  }
  for (const i of outcome.unmatchedBooks) {
    const row = bookRows[i];
    entries.push({
      key: "",
      bucket: "missing_in_2b",
      tier: null,
      supplierGstin: normaliseGstinText(row.supplierGstin),
      supplierName: row.supplierName,
      portal: null,
      books: row,
      deltas: null,
      dateDeltaDays: null,
      itc: { portal: 0, books: totalTax(row) },
      notes: leftoverNotes(row, "missing_in_2b"),
    });
  }
  entries.sort(sortEntries);
  for (const e of entries) e.key = uniqueKey(entryKeyBase((e.portal ?? e.books) as GstDocRow));

  // Names: prefer the portal's trade name for the supplier everywhere.
  const names = new Map<string, string>();
  for (const r of portalRows) if (r.supplierName) names.set(normaliseGstinText(r.supplierGstin), r.supplierName);
  for (const r of bookRows) {
    const g = normaliseGstinText(r.supplierGstin);
    if (r.supplierName && !names.has(g)) names.set(g, r.supplierName);
  }
  for (const e of entries) e.supplierName = names.get(e.supplierGstin) ?? e.supplierName;

  const summary = summarise(entries, portalRows, bookRows);
  const suppliers = rollUpSuppliers(entries, names);

  // IMS: a 2B leftover whose loose number already matched for the same supplier is a likely duplicate.
  const matchedKeys = new Set(
    entries.filter((e) => e.portal && (e.bucket === "matched" || e.bucket === "mismatch")).map((e) => entryKeyBase(e.portal as GstDocRow)),
  );
  const ims = entries
    .map((e) => imsActionFor(e, params, e.bucket === "missing_in_books" && e.portal !== null && matchedKeys.has(entryKeyBase(e.portal))))
    .filter((x): x is ImsItem => x !== null);

  const warnings: ReconWarning[] = [];
  const gstinWarning = checkPortalGstin(opts.portalGstin ?? null, opts.clientGstin);
  if (gstinWarning && !(gstinWarning.code === "no_portal_gstin" && opts.portalGstin === undefined)) warnings.push(gstinWarning);
  warnings.push(...duplicateWarnings(bookRows, "books"), ...duplicateWarnings(portalRows, "2b"));

  return { entries, summary, suppliers, ims, warnings, params };
}

function summarise(entries: readonly ReconEntry[], portalRows: readonly GstDocRow[], bookRows: readonly GstDocRow[]): ReconSummary {
  const buckets = emptyBucketTotals();
  const byTier: Record<MatchTier, number> = { exact: 0, loose: 0, fuzzy: 0 };
  let unclaimed = 0;
  let reversalPending = 0;
  let atRiskMissing = 0;
  let atRiskExcess = 0;
  let mismatchDifference = 0;

  for (const e of entries) {
    const t = buckets[e.bucket];
    t.count++;
    addInto(t.portal, e.portal);
    addInto(t.books, e.books);
    t.portalItc += e.itc.portal;
    t.booksItc += e.itc.books;
    if (e.tier) byTier[e.tier]++;
    if (e.bucket === "missing_in_books" && e.portal) {
      if (isCreditDoc(e.portal.docType)) reversalPending += Math.abs(e.itc.portal);
      else if (e.portal.itcAvailable !== false) unclaimed += e.itc.portal;
    }
    if (e.bucket === "missing_in_2b" && e.books && !isCreditDoc(e.books.docType)) atRiskMissing += e.itc.books;
    if (e.bucket === "mismatch") {
      mismatchDifference += e.itc.portal - e.itc.books;
      atRiskExcess += Math.max(0, e.itc.books - e.itc.portal);
    }
  }

  let per2b = 0;
  let notAvailable = 0;
  for (const r of portalRows) {
    if (r.itcAvailable === false) notAvailable += totalTax(r);
    else per2b += totalTax(r);
  }
  const perBooks = bookRows.reduce((s, r) => s + totalTax(r), 0);

  return {
    buckets,
    byTier,
    documents: { portal: portalRows.length, books: bookRows.length },
    itc: {
      per2b,
      notAvailablePer2b: notAvailable,
      perBooks,
      matched: buckets.matched.booksItc,
      mismatched: buckets.mismatch.booksItc,
      mismatchDifference,
      unclaimed,
      reversalPending,
      atRisk: atRiskMissing + atRiskExcess,
      atRiskMissingIn2b: atRiskMissing,
      atRiskExcessOverTwoB: atRiskExcess,
      available: per2b,
    },
  };
}

function rollUpSuppliers(entries: readonly ReconEntry[], names: ReadonlyMap<string, string>): SupplierRollup[] {
  const map = new Map<string, SupplierRollup>();
  for (const e of entries) {
    let s = map.get(e.supplierGstin);
    if (!s) {
      s = {
        supplierGstin: e.supplierGstin,
        supplierName: names.get(e.supplierGstin) ?? e.supplierName,
        counts: emptyCounts(),
        itcAtRisk: 0,
        unclaimedItc: 0,
        mismatchDifference: 0,
        missingIn2b: [],
        mismatches: [],
        missingInBooks: [],
        chase: false,
      };
      map.set(e.supplierGstin, s);
    }
    s.counts[e.bucket]++;
    if (e.bucket === "missing_in_2b" && e.books) {
      s.missingIn2b.push(e.books);
      if (!isCreditDoc(e.books.docType)) s.itcAtRisk += e.itc.books;
    }
    if (e.bucket === "missing_in_books" && e.portal) {
      s.missingInBooks.push(e.portal);
      if (!isCreditDoc(e.portal.docType) && e.portal.itcAvailable !== false) s.unclaimedItc += e.itc.portal;
    }
    if (e.bucket === "mismatch") {
      s.mismatches.push(e);
      s.mismatchDifference += e.itc.portal - e.itc.books;
      s.itcAtRisk += Math.max(0, e.itc.books - e.itc.portal);
    }
  }
  const list = [...map.values()];
  for (const s of list) s.chase = s.missingIn2b.length > 0 || s.mismatches.length > 0;
  return list.sort(
    (a, b) =>
      b.itcAtRisk - a.itcAtRisk ||
      Math.abs(b.mismatchDifference) - Math.abs(a.mismatchDifference) ||
      b.unclaimedItc - a.unclaimedItc ||
      cmp(a.supplierName ?? a.supplierGstin, b.supplierName ?? b.supplierGstin),
  );
}

/** Only the suppliers to chase (missing documents or mismatches), highest value at risk first. */
export function suppliersToChase(result: Pick<ReconResult, "suppliers">): SupplierRollup[] {
  return result.suppliers.filter((s) => s.chase);
}

// -------------------------------------------------------------------------------------------------
// Supplier follow-up (§7.8.1 "Draft supplier follow-up", §7.13.4)
// -------------------------------------------------------------------------------------------------

/**
 * The lines to list in a supplier follow-up (the `{{missing_items}}` of the template): the documents
 * the supplier hasn't reported, then the ones whose amounts differ.
 */
export function supplierFollowUpItems(supplier: Pick<SupplierRollup, "missingIn2b" | "mismatches">): string[] {
  const lines = supplier.missingIn2b.map(
    (r) =>
      `${GST_DOC_TYPE_LABELS[r.docType]} ${r.docNumber} dated ${formatDocDate(r.docDate)}: taxable ${formatINR(Math.abs(r.taxable))}, GST ${formatINR(Math.abs(totalTax(r)))}, not in our GSTR-2B.`,
  );
  for (const e of supplier.mismatches) {
    const b = e.books as GstDocRow;
    lines.push(
      `${GST_DOC_TYPE_LABELS[b.docType]} ${b.docNumber} dated ${formatDocDate(b.docDate)}: our books show GST ${formatINR(Math.abs(e.itc.books))}, GSTR-2B shows ${formatINR(Math.abs(e.itc.portal))}.`,
    );
  }
  return lines;
}

// -------------------------------------------------------------------------------------------------
// Carry-forward (§6.12: "the next month shows what carried forward")
// -------------------------------------------------------------------------------------------------

export type OpenBucket = Exclude<ReconBucket, "matched">;

/** An unresolved line from a saved run, carried into the next month's run. */
export type OpenItem = {
  key: string;
  bucket: OpenBucket;
  /** MMYYYY of the run it first appeared in. */
  firstSeenPeriod: string;
  supplierGstin: string;
  supplierName: string | null;
  portal: GstDocRow | null;
  books: GstDocRow | null;
};

/**
 * The open lines of a run (§6.12): everything except matched pairs and lines resolved as
 * `accepted` or `ignore`. `follow_up_supplier` stays open until the supplier acts.
 */
export function openItemsOf(
  result: Pick<ReconResult, "entries">,
  period: string,
  resolutions: Readonly<Record<string, ReconResolution>> = {},
): OpenItem[] {
  return result.entries
    .filter((e) => e.bucket !== "matched")
    .filter((e) => {
      const r = resolutions[e.key];
      return r !== "accepted" && r !== "ignore";
    })
    .map((e) => ({
      key: e.key,
      bucket: e.bucket as OpenBucket,
      firstSeenPeriod: period,
      supplierGstin: e.supplierGstin,
      supplierName: e.supplierName,
      portal: e.portal,
      books: e.books,
    }));
}

function toOpenItem(item: OpenItem): OpenItem {
  return {
    key: item.key,
    bucket: item.bucket,
    firstSeenPeriod: item.firstSeenPeriod,
    supplierGstin: item.supplierGstin,
    supplierName: item.supplierName,
    portal: item.portal,
    books: item.books,
  };
}

/** Whole months from `from` to `to`, both MMYYYY (`082026` → `102026` is 2); null if either is malformed. */
export function monthsBetweenPeriods(from: string, to: string): number | null {
  const p = (s: string) => {
    const m = /^(0[1-9]|1[0-2])(\d{4})$/.exec(s.trim());
    return m ? Number(m[2]) * 12 + Number(m[1]) - 1 : null;
  };
  const a = p(from);
  const b = p(to);
  return a === null || b === null ? null : b - a;
}

export type ClearedItem = {
  item: OpenItem;
  /** The entry of this month's run that closes it. */
  entryKey: string;
  tier: MatchTier;
  /** False when the two documents pair up but a tax head differs by more than ₹1. */
  amountsAgree: boolean;
  message: string;
};

export type CarryForwardResult = {
  cleared: ClearedItem[];
  stillOpen: Array<OpenItem & { monthsOpen: number | null }>;
  /** Keys of this month's entries that are last month's items arriving (don't chase them twice). */
  explainedEntryKeys: string[];
  /** What to carry into next month: the items still open plus this month's own open lines. */
  openForNextMonth: OpenItem[];
};

/**
 * Compares this month's run with last month's open items (§6.12):
 * - a document booked last month but missing from last month's 2B that now appears in this month's
 *   2B (and isn't in this month's books) is **cleared**: the supplier has reported it;
 * - a document in last month's 2B that wasn't booked and is in this month's books (but not this
 *   month's 2B) is **cleared**: it has been booked;
 * - everything else stays open, with how many months it has been open.
 * Matching uses the same tiers as the run itself.
 */
export function carryForward(
  previousOpen: readonly OpenItem[],
  current: Pick<ReconResult, "entries">,
  period: string,
  opts: { resolutions?: Readonly<Record<string, ReconResolution>>; params?: Partial<ReconParams> } = {},
): CarryForwardResult {
  const params: ReconParams = { ...RECON_DEFAULTS, ...opts.params };
  const cleared: ClearedItem[] = [];
  const clearedPrev = new Set<number>();
  const explained = new Set<string>();

  const currentMissingInBooks = current.entries.filter((e) => e.bucket === "missing_in_books" && e.portal);
  const currentMissingIn2b = current.entries.filter((e) => e.bucket === "missing_in_2b" && e.books);

  // Last month: booked, not in 2B → this month: in 2B, not booked.
  const prevBooked = previousOpen.map((item, i) => ({ item, i })).filter((x) => x.item.bucket === "missing_in_2b" && x.item.books);
  const filed = matchDocuments(
    currentMissingInBooks.map((e) => e.portal as GstDocRow),
    prevBooked.map((x) => x.item.books as GstDocRow),
    params,
  );
  for (const pair of filed.pairs) {
    const entry = currentMissingInBooks[pair.portal];
    const prev = prevBooked[pair.books];
    const agree = headsWithinTolerance(amountDeltas(entry.portal as GstDocRow, prev.item.books as GstDocRow), params.headTolerancePaise);
    clearedPrev.add(prev.i);
    explained.add(entry.key);
    cleared.push({
      item: prev.item,
      entryKey: entry.key,
      tier: pair.tier,
      amountsAgree: agree,
      message: `The supplier has now reported it in this month's GSTR-2B (it was missing in ${periodLabelOf(prev.item.firstSeenPeriod) ?? prev.item.firstSeenPeriod}). Claim the ITC in this month's return.${agree ? "" : " The amounts differ from the books: check them."}`,
    });
  }

  // Last month: in 2B, not booked → this month: booked, not in 2B.
  const prevUnbooked = previousOpen.map((item, i) => ({ item, i })).filter((x) => x.item.bucket === "missing_in_books" && x.item.portal);
  const booked = matchDocuments(
    prevUnbooked.map((x) => x.item.portal as GstDocRow),
    currentMissingIn2b.map((e) => e.books as GstDocRow),
    params,
  );
  for (const pair of booked.pairs) {
    const prev = prevUnbooked[pair.portal];
    const entry = currentMissingIn2b[pair.books];
    const agree = headsWithinTolerance(amountDeltas(prev.item.portal as GstDocRow, entry.books as GstDocRow), params.headTolerancePaise);
    clearedPrev.add(prev.i);
    explained.add(entry.key);
    cleared.push({
      item: prev.item,
      entryKey: entry.key,
      tier: pair.tier,
      amountsAgree: agree,
      message: `Booked this month; it was in the GSTR-2B for ${periodLabelOf(prev.item.firstSeenPeriod) ?? prev.item.firstSeenPeriod}.${agree ? "" : " The amounts differ from the 2B: check them."}`,
    });
  }

  const stillOpen = previousOpen
    .filter((_, i) => !clearedPrev.has(i))
    .map((item) => ({ ...item, monthsOpen: monthsBetweenPeriods(item.firstSeenPeriod, period) }));
  const ownOpen = openItemsOf(current, period, opts.resolutions).filter((item) => !explained.has(item.key));
  return {
    cleared,
    stillOpen,
    explainedEntryKeys: [...explained],
    openForNextMonth: [...stillOpen.map(toOpenItem), ...ownOpen],
  };
}

// -------------------------------------------------------------------------------------------------
// Export (§6.12 "Excel export")
// -------------------------------------------------------------------------------------------------

export const RECON_EXPORT_HEADERS = [
  "Bucket",
  "Match",
  "Supplier GSTIN",
  "Supplier name",
  "Document type",
  "2B number",
  "2B date",
  "Books number",
  "Books date",
  "2B taxable",
  "Books taxable",
  "2B IGST",
  "Books IGST",
  "2B CGST",
  "Books CGST",
  "2B SGST",
  "Books SGST",
  "2B cess",
  "Books cess",
  "ITC difference (2B − books)",
  "Notes",
] as const;

/** A cell of the export: text, or rupees as a number with two decimals (for Excel). */
export type ExportCell = string | number | null;

function rupees(p: Paise | null | undefined): number | null {
  return p === null || p === undefined ? null : fromPaise(p);
}

/**
 * One row per entry, in the order of `RECON_EXPORT_HEADERS`. Amounts are rupees (`fromPaise`), for
 * the spreadsheet only; never compute with them.
 */
export function reconExportRows(result: Pick<ReconResult, "entries">): ExportCell[][] {
  return result.entries.map((e) => {
    const p = e.portal;
    const b = e.books;
    const doc = (p ?? b) as GstDocRow;
    return [
      RECON_BUCKET_LABELS[e.bucket],
      e.tier ? MATCH_TIER_LABELS[e.tier] : null,
      e.supplierGstin,
      e.supplierName,
      GST_DOC_TYPE_LABELS[doc.docType],
      p?.docNumber ?? null,
      p?.docDate ?? null,
      b?.docNumber ?? null,
      b?.docDate ?? null,
      rupees(p?.taxable),
      rupees(b?.taxable),
      rupees(p?.igst),
      rupees(b?.igst),
      rupees(p?.cgst),
      rupees(b?.cgst),
      rupees(p?.sgst),
      rupees(b?.sgst),
      rupees(p?.cess),
      rupees(b?.cess),
      rupees(e.itc.portal - e.itc.books),
      e.notes.join(" "),
    ];
  });
}
