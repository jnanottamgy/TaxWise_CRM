/**
 * Fee realisation (§7.9.10): per client and service, the fee agreed for the periods due so far
 * (engagement fees, excl. GST) against what was invoiced (fees, excl. GST, net of credit notes)
 * and what was collected (the fee share of received + TDS); billing % = invoiced ÷ agreed,
 * realisation % = collected ÷ invoiced; and the leakage list: engagement periods that have ended
 * with no invoice.
 *
 * Pure and client-safe. Integer paise; shares are split by the largest-remainder method so they
 * always add up to the whole.
 */

import { SERVICE_FREQUENCY_LABELS, SERVICE_TYPE_LABELS, type ClientStatus, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums";
import { addMonths, compareDates, endOfMonth, fyEnd, fyStart, monthPeriodLabel, quarterLabel, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { normalisePeriodLabel } from "@/lib/domain/invoice";
import { splitEvenly, type Paise } from "@/lib/domain/money";
import { ratioPercent } from "@/lib/domain/collections";

// -------------------------------------------------------------------------------------------------
// Allocation
// -------------------------------------------------------------------------------------------------

/**
 * Splits `total` across shares in proportion to `weights` (negative weights count as 0), largest
 * remainder first, so the shares add up to `total` exactly. With no positive weight, splits evenly.
 * `allocateByWeights(10000, [1, 1, 1])` → `[3334, 3333, 3333]`.
 */
export function allocateByWeights(total: Paise, weights: readonly Paise[]): Paise[] {
  if (!Number.isSafeInteger(total)) throw new RangeError("Allocate whole paise.");
  if (weights.length === 0) return [];
  const w = weights.map((x) => (x > 0 ? BigInt(x) : BigInt(0)));
  const sum = w.reduce((a, b) => a + b, BigInt(0));
  if (sum === BigInt(0)) return splitEvenly(total, weights.length);
  const sign = total < 0 ? -1 : 1;
  const abs = BigInt(Math.abs(total));
  const floors = w.map((x) => (abs * x) / sum);
  const rems = w.map((x, i) => ({ i, r: (abs * x) % sum }));
  let left = abs - floors.reduce((a, b) => a + b, BigInt(0));
  rems.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of rems) {
    if (left <= BigInt(0)) break;
    floors[i] += BigInt(1);
    left -= BigInt(1);
  }
  return floors.map((f) => {
    const n = sign * Number(f);
    return n === 0 ? 0 : n;
  });
}

// -------------------------------------------------------------------------------------------------
// Billing periods
// -------------------------------------------------------------------------------------------------

export type BillingCycle = Exclude<ServiceFrequency, "one_time">;

export type BillingPeriod = { label: string; start: DateString; end: DateString };

/** The billing periods of an FY for a cycle: 12 months (`Apr 2026` …), 4 quarters (`Q1 2026-27` …) or the year (`FY 2026-27`). */
export function billingPeriodsOf(fy: FinancialYear, cycle: BillingCycle): BillingPeriod[] {
  const start = fyStart(fy);
  if (cycle === "annual") return [{ label: `FY ${fy}`, start, end: fyEnd(fy) }];
  const step = cycle === "monthly" ? 1 : 3;
  const out: BillingPeriod[] = [];
  for (let k = 0; k < 12; k += step) {
    const s = addMonths(start, k);
    const e = endOfMonth(addMonths(s, step - 1));
    out.push({ label: cycle === "monthly" ? monthPeriodLabel(s) : quarterLabel(s), start: s, end: e });
  }
  return out;
}

/** The fee in force on a day: the last change on or before it, else the first one recorded, else the current fee. */
export function feeInForce(history: ReadonlyArray<{ changedOn: DateString; agreedFeePaise: Paise | null }>, on: DateString, current: Paise | null): Paise | null {
  if (history.length === 0) return current;
  const sorted = [...history].sort((a, b) => compareDates(a.changedOn, b.changedOn));
  let fee: Paise | null = sorted[0].agreedFeePaise;
  for (const h of sorted) {
    if (compareDates(h.changedOn, on) <= 0) fee = h.agreedFeePaise;
    else break;
  }
  return fee;
}

/** `client_service_id|normalised period`: how an invoice's period is matched to an engagement's. */
export function periodKey(clientServiceId: string, periodLabel: string): string {
  return `${clientServiceId}|${normalisePeriodLabel(periodLabel)}`;
}

// -------------------------------------------------------------------------------------------------
// The report
// -------------------------------------------------------------------------------------------------

export type RealisationEngagement = {
  id: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  clientStatus: ClientStatus;
  serviceType: ServiceType;
  customName: string | null;
  frequency: ServiceFrequency;
  billingFrequency: ServiceFrequency | null;
  isActive: boolean;
  agreedFeePaise: Paise | null;
  /** When the engagement began (fee agreed, else created). */
  startedOn: DateString;
  /** For an ended engagement: the day it was last changed (when it was ended). */
  endedOn: DateString | null;
  feeHistory: ReadonlyArray<{ changedOn: DateString; agreedFeePaise: Paise | null }>;
};

export type RealisationLine = {
  amountPaise: Paise;
  isReimbursement: boolean;
  serviceType: ServiceType | null;
  clientServiceId: string | null;
};

export type RealisationInvoice = {
  id: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  issueDate: DateString;
  /** The invoice's own engagement (retainer source), used for lines that don't name one. */
  clientServiceId: string | null;
  serviceType: ServiceType | null;
  totalPaise: Paise;
  /** Credit notes on the invoice: total and the taxable part. */
  creditNotedPaise: Paise;
  creditTaxablePaise: Paise;
  /** Received + TDS. */
  collectedPaise: Paise;
  lines: readonly RealisationLine[];
};

export type RealisationRow = {
  key: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  engagementId: string | null;
  serviceType: ServiceType;
  serviceLabel: string;
  /** "Monthly", "Quarterly", "Annual", "One-time"; null for invoices not tied to an engagement. */
  cycleLabel: string | null;
  agreedPaise: Paise;
  invoicedPaise: Paise;
  collectedPaise: Paise;
  billingPercent: number | null;
  realisationPercent: number | null;
  /** Ended periods with no invoice. */
  leakagePeriods: number;
  active: boolean;
};

export type LeakageItem = {
  engagementId: string;
  clientId: string;
  clientName: string;
  clientCode: string;
  serviceLabel: string;
  periodLabel: string;
  periodStart: DateString;
  periodEnd: DateString;
  agreedPaise: Paise;
};

export type RealisationReport = {
  rows: RealisationRow[];
  totals: { agreedPaise: Paise; invoicedPaise: Paise; collectedPaise: Paise; billingPercent: number | null; realisationPercent: number | null };
  leakage: LeakageItem[];
};

export function serviceLabel(serviceType: ServiceType, customName: string | null | undefined): string {
  return serviceType === "other" && customName?.trim() ? customName.trim() : SERVICE_TYPE_LABELS[serviceType];
}

const NOT_BILLED: ReadonlySet<ClientStatus> = new Set<ClientStatus>(["on_hold", "inactive"]);

/**
 * Builds the realisation report for an FY as at `asOf` (§7.9.10).
 *
 * - Agreed: for each engagement with a fee, the fee in force at each billing period of the FY that
 *   has started by `asOf` and overlaps the engagement (from the day it began; an ended engagement up
 *   to the day it was ended). A one-time engagement counts once, in the FY it began.
 * - Invoiced: the fee lines (excl. GST and reimbursements) of the invoices issued in the FY, less
 *   the taxable part of their credit notes, split across the lines by amount.
 * - Collected: the share of each invoice's received + TDS that its fee lines make up of the invoice
 *   (net of credit notes), split the same way.
 * Lines tied to an engagement (or on an invoice raised from one) count against it; the rest are
 * grouped per client and service as "not tied to an engagement".
 * - Leakage: periods of active, fee-bearing, recurring engagements of clients being billed (not On
 *   hold or Inactive) that ended before `asOf` with no invoice (a draft counts as raised) for the
 *   engagement and period (`billedPeriodKeys`, from `periodKey`).
 */
export function buildRealisation(input: {
  fy: FinancialYear;
  asOf: DateString;
  engagements: readonly RealisationEngagement[];
  invoices: readonly RealisationInvoice[];
  billedPeriodKeys: ReadonlySet<string>;
}): RealisationReport {
  const fyFrom = fyStart(input.fy);
  const fyTo = fyEnd(input.fy);
  const rows = new Map<string, RealisationRow>();
  const leakage: LeakageItem[] = [];
  const engagementById = new Map(input.engagements.map((e) => [e.id, e]));

  const rowFor = (key: string, seed: () => RealisationRow): RealisationRow => {
    let r = rows.get(key);
    if (!r) {
      r = seed();
      rows.set(key, r);
    }
    return r;
  };
  const engagementRow = (e: RealisationEngagement) =>
    rowFor(`eng:${e.id}`, () => ({
      key: `eng:${e.id}`,
      clientId: e.clientId,
      clientName: e.clientName,
      clientCode: e.clientCode,
      engagementId: e.id,
      serviceType: e.serviceType,
      serviceLabel: serviceLabel(e.serviceType, e.customName),
      cycleLabel: SERVICE_FREQUENCY_LABELS[e.billingFrequency ?? e.frequency],
      agreedPaise: 0,
      invoicedPaise: 0,
      collectedPaise: 0,
      billingPercent: null,
      realisationPercent: null,
      leakagePeriods: 0,
      active: e.isActive,
    }));

  // Agreed and leakage.
  for (const e of input.engagements) {
    if (e.agreedFeePaise === null && e.feeHistory.every((h) => h.agreedFeePaise === null)) continue;
    const cycle = e.billingFrequency ?? e.frequency;
    const until = e.isActive ? input.asOf : e.endedOn && compareDates(e.endedOn, input.asOf) < 0 ? e.endedOn : input.asOf;
    if (e.frequency === "one_time" || cycle === "one_time") {
      if (compareDates(e.startedOn, fyFrom) >= 0 && compareDates(e.startedOn, fyTo) <= 0 && compareDates(e.startedOn, input.asOf) <= 0) {
        const fee = feeInForce(e.feeHistory, e.startedOn, e.agreedFeePaise) ?? 0;
        if (fee > 0) engagementRow(e).agreedPaise += fee;
      }
      continue;
    }
    const row = engagementRow(e);
    for (const p of billingPeriodsOf(input.fy, cycle)) {
      if (compareDates(p.start, until) > 0) continue;
      if (compareDates(p.end, e.startedOn) < 0) continue;
      const on = compareDates(p.start, e.startedOn) >= 0 ? p.start : e.startedOn;
      const fee = feeInForce(e.feeHistory, on, e.agreedFeePaise) ?? 0;
      if (fee <= 0) continue;
      row.agreedPaise += fee;
      const ended = compareDates(p.end, input.asOf) < 0;
      if (ended && e.isActive && !NOT_BILLED.has(e.clientStatus) && !input.billedPeriodKeys.has(periodKey(e.id, p.label))) {
        row.leakagePeriods += 1;
        leakage.push({
          engagementId: e.id,
          clientId: e.clientId,
          clientName: e.clientName,
          clientCode: e.clientCode,
          serviceLabel: row.serviceLabel,
          periodLabel: p.label,
          periodStart: p.start,
          periodEnd: p.end,
          agreedPaise: fee,
        });
      }
    }
  }

  // Invoiced and collected.
  for (const inv of input.invoices) {
    const fees = inv.lines.filter((l) => !l.isReimbursement);
    if (fees.length === 0) continue;
    const gross = fees.map((l) => l.amountPaise);
    const credit = allocateByWeights(Math.min(inv.creditTaxablePaise, gross.reduce((a, b) => a + b, 0)), gross);
    const net = gross.map((g, i) => g - credit[i]);
    const netFees = net.reduce((a, b) => a + b, 0);
    const netTotal = inv.totalPaise - inv.creditNotedPaise;
    const collectedFees =
      netTotal > 0 && netFees > 0 ? Number((BigInt(Math.min(inv.collectedPaise, netTotal)) * BigInt(netFees) * BigInt(2) + BigInt(netTotal)) / (BigInt(netTotal) * BigInt(2))) : 0;
    const collected = allocateByWeights(collectedFees, net);
    fees.forEach((l, i) => {
      const engagement = engagementById.get(l.clientServiceId ?? inv.clientServiceId ?? "");
      let row: RealisationRow;
      if (engagement && engagement.clientId === inv.clientId) {
        row = engagementRow(engagement);
      } else {
        const service: ServiceType = l.serviceType ?? inv.serviceType ?? "other";
        const key = `adhoc:${inv.clientId}:${service}`;
        row = rowFor(key, () => ({
          key,
          clientId: inv.clientId,
          clientName: inv.clientName,
          clientCode: inv.clientCode,
          engagementId: null,
          serviceType: service,
          serviceLabel: SERVICE_TYPE_LABELS[service],
          cycleLabel: null,
          agreedPaise: 0,
          invoicedPaise: 0,
          collectedPaise: 0,
          billingPercent: null,
          realisationPercent: null,
          leakagePeriods: 0,
          active: true,
        }));
      }
      row.invoicedPaise += net[i];
      row.collectedPaise += collected[i];
    });
  }

  const list = [...rows.values()].filter((r) => r.agreedPaise !== 0 || r.invoicedPaise !== 0 || r.collectedPaise !== 0 || r.leakagePeriods > 0);
  for (const r of list) {
    r.billingPercent = ratioPercent(r.invoicedPaise, r.agreedPaise);
    r.realisationPercent = ratioPercent(r.collectedPaise, r.invoicedPaise);
  }
  const agreed = list.reduce((s, r) => s + r.agreedPaise, 0);
  const invoiced = list.reduce((s, r) => s + r.invoicedPaise, 0);
  const collected = list.reduce((s, r) => s + r.collectedPaise, 0);
  leakage.sort((a, b) => compareDates(a.periodEnd, b.periodEnd) || a.clientName.localeCompare(b.clientName) || a.serviceLabel.localeCompare(b.serviceLabel));
  return {
    rows: list,
    totals: { agreedPaise: agreed, invoicedPaise: invoiced, collectedPaise: collected, billingPercent: ratioPercent(invoiced, agreed), realisationPercent: ratioPercent(collected, invoiced) },
    leakage,
  };
}

export const REALISATION_SORTS = ["client", "service", "agreed", "invoiced", "collected", "billing", "realisation", "leakage"] as const;
export type RealisationSort = (typeof REALISATION_SORTS)[number];

/** Sorts report rows in place-safe fashion (a copy); nulls (no base) go last either way. */
export function sortRealisationRows(rows: readonly RealisationRow[], sort: RealisationSort, dir: "asc" | "desc"): RealisationRow[] {
  const mul = dir === "asc" ? 1 : -1;
  const nullLast = (a: number | null, b: number | null) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : mul * (a - b));
  const tie = (a: RealisationRow, b: RealisationRow) => a.clientName.localeCompare(b.clientName) || a.serviceLabel.localeCompare(b.serviceLabel) || a.key.localeCompare(b.key);
  return [...rows].sort((a, b) => {
    let c = 0;
    switch (sort) {
      case "client":
        c = mul * a.clientName.localeCompare(b.clientName);
        break;
      case "service":
        c = mul * a.serviceLabel.localeCompare(b.serviceLabel);
        break;
      case "agreed":
        c = mul * (a.agreedPaise - b.agreedPaise);
        break;
      case "invoiced":
        c = mul * (a.invoicedPaise - b.invoicedPaise);
        break;
      case "collected":
        c = mul * (a.collectedPaise - b.collectedPaise);
        break;
      case "billing":
        c = nullLast(a.billingPercent, b.billingPercent);
        break;
      case "realisation":
        c = nullLast(a.realisationPercent, b.realisationPercent);
        break;
      case "leakage":
        c = mul * (a.leakagePeriods - b.leakagePeriods);
        break;
    }
    return c || tie(a, b);
  });
}
