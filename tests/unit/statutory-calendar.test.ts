import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addMonths, isSunday } from "@/lib/domain/fy";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { toPaise } from "@/lib/domain/money";
import { qrmpGstr3bDay, SCALE_DEFAULTS } from "@/lib/domain/scale";
import {
  applyOverride,
  CALENDAR_DEFAULTS,
  CALENDAR_SEED_PARAMETERS,
  coverageGaps,
  dir3KycNextDueFy,
  DUE_DATE_OVERRIDE_SEED,
  DUE_DATE_RULE_SEED,
  dueDateRuleRow,
  effectiveGstScheme,
  filingBarDate,
  filingBarStatus,
  formatDay,
  generateEvents,
  generateOpsEvents,
  isAuditCase,
  isNearFilingBar,
  isUnfiled,
  lateFeeAccrued,
  OPS_TEMPLATE_DEFAULTS,
  parseAppliesTo,
  parseDueDateOverrideRow,
  parseDueDateRuleRow,
  parseRuleSpec,
  planEventSync,
  reminderDate,
  removeOverride,
  resolveCalendarParams,
  ruleAppliesTo,
  ruleKind,
  stateDayParamsOf,
  sundayHint,
  toComplianceEventInsert,
  type CalendarClientProfile,
  type CalendarEvent,
  type DueDateOverride,
  type DueDateRule,
  type GenerateOptions,
  type OpsTemplate,
  type StoredEvent,
} from "@/lib/domain/statutory-calendar";
import { renderDueDateSeedSql, SEED_SQL_RELATIVE_PATH, sqlText } from "@/scripts/gen-due-date-seed";

const RULES = DUE_DATE_RULE_SEED;
const OVERRIDES = DUE_DATE_OVERRIDE_SEED;
const CRORE = 1_00_00_000;
const TODAY = "2026-10-22";

function profile(p: Partial<CalendarClientProfile> = {}): CalendarClientProfile {
  return {
    id: "c1",
    serviceTypes: [],
    entityType: "pvt_ltd",
    gstScheme: null,
    stateCode: "29",
    turnover: toPaise(3 * CRORE),
    taxAuditApplicable: "no",
    ...p,
  };
}

function gen(p: Partial<CalendarClientProfile>, opts: Partial<GenerateOptions> = {}, overrides: readonly DueDateOverride[] = OVERRIDES, rules: readonly DueDateRule[] = RULES) {
  return generateEvents(profile(p), rules, overrides, { today: TODAY, ...opts });
}

function byRule(events: CalendarEvent[], code: string) {
  return events.filter((e) => e.ruleCode === code);
}

function one(events: CalendarEvent[], code: string, period: string): CalendarEvent {
  const found = events.filter((e) => e.ruleCode === code && e.filingPeriod === period);
  expect(found, `${code} ${period}`).toHaveLength(1);
  return found[0];
}

function rule(code: string): DueDateRule {
  const r = RULES.find((x) => x.code === code);
  if (!r) throw new Error(`no rule ${code}`);
  return r;
}

// =================================================================================================
describe("the §6.7 seed", () => {
  it("has one row per rule, with the codes the spec and the brief name", () => {
    const codes = RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of [
      "GSTR1_MONTHLY", "GSTR1_QRMP", "IFF", "GSTR3B_MONTHLY", "GSTR3B_QRMP", "PMT06", "CMP08", "GSTR4", "GSTR7", "GSTR8", "GSTR9", "GSTR9C",
      "ITR_NON_AUDIT_1_2", "ITR_NON_AUDIT_3_4", "TAX_AUDIT_REPORT", "ITR_AUDIT", "FORM_3CEB", "ITR_TP", "ITR_BELATED",
      "ADVANCE_TAX_Q1", "ADVANCE_TAX_Q2", "ADVANCE_TAX_Q3", "ADVANCE_TAX_Q4", "TDS_DEPOSIT",
      "TDS_RETURN_Q1", "TDS_RETURN_Q2", "TDS_RETURN_Q3", "TDS_RETURN_Q4", "FORM16", "FORM16A",
      "AGM", "ADT1", "AOC4", "AOC4_OPC", "MGT7", "DPT3", "MSME1_H1", "MSME1_H2", "DIR3_KYC_WEB", "LLP_FORM11", "LLP_FORM8",
      "PF_ESIC", "PT_KA_MONTHLY", "PT_KA_ANNUAL",
    ]) {
      expect(codes).toContain(code);
    }
  });

  it("every rule survives a database round trip unchanged (the JSON is what the engine reads)", () => {
    for (const r of RULES) {
      const row = JSON.parse(JSON.stringify(dueDateRuleRow(r)));
      const parsed = parseDueDateRuleRow(row);
      expect(parsed, r.code).toEqual({ ok: true, value: r });
    }
  });

  it("[verify] rows are seeded unverified, settled law verified", () => {
    for (const r of RULES) expect(r.verified, r.code).toBe(!r.sourceRef?.includes("[verify"));
    for (const code of ["ITR_NON_AUDIT_3_4", "GSTR9", "PT_KA_MONTHLY", "PT_KA_ANNUAL", "TAX_AUDIT_REPORT"]) expect(rule(code).verified).toBe(false);
    for (const code of ["GSTR3B_QRMP", "ITR_AUDIT", "ITR_NON_AUDIT_1_2", "DIR3_KYC_WEB", "TDS_DEPOSIT", "AOC4", "PF_ESIC"]) expect(rule(code).verified).toBe(true);
  });

  it("every rule shows its legal source", () => {
    for (const r of RULES) expect(r.sourceRef?.length ?? 0, r.code).toBeGreaterThan(10);
  });

  it("the two CBDT Circular 07/2026 extensions are override rows, not rule changes", () => {
    expect(OVERRIDES).toEqual([
      expect.objectContaining({ ruleCode: "TAX_AUDIT_REPORT", periodLabel: "AY 2026-27", originalDue: "2026-09-30", extendedDue: "2026-10-21", sourceRef: "CBDT Circular 07/2026 dated 28 Sep 2026" }),
      expect.objectContaining({ ruleCode: "ITR_AUDIT", periodLabel: "AY 2026-27", originalDue: "2026-10-31", extendedDue: "2026-11-21", sourceRef: "CBDT Circular 07/2026 dated 28 Sep 2026" }),
    ]);
    expect(rule("TAX_AUDIT_REPORT").rule).toMatchObject({ fixed: "09-30" });
    expect(rule("ITR_AUDIT").rule).toMatchObject({ fixed: "10-31" });
  });

  it("the GSTR3B_QRMP rule carries the same state days as scale.ts", () => {
    const params = stateDayParamsOf(rule("GSTR3B_QRMP"));
    expect(params).toEqual(SCALE_DEFAULTS.qrmpGstr3b);
    for (let code = 1; code <= 38; code++) {
      const c = String(code).padStart(2, "0");
      expect(qrmpGstr3bDay(c, params ?? undefined)).toBe(qrmpGstr3bDay(c));
    }
    expect(stateDayParamsOf(rule("GSTR3B_MONTHLY"))).toBeNull();
  });
});

describe("supabase/seed/30_due_date_rules.sql", () => {
  const path = join(process.cwd(), SEED_SQL_RELATIVE_PATH);
  const sql = readFileSync(path, "utf8");

  it("is exactly what scripts/gen-due-date-seed.ts writes from the TypeScript", () => {
    expect(sql).toBe(renderDueDateSeedSql());
  });

  it("holds rule JSON the engine reads back to the TypeScript seed", () => {
    const ruleLines = sql.split("\n").filter((l) => /^ {2}\('[A-Z0-9_]+', /.test(l) && l.includes("::public.compliance_type"));
    expect(ruleLines).toHaveLength(RULES.length);
    for (const line of ruleLines) {
      const code = /^ {2}\('([A-Z0-9_]+)'/.exec(line)?.[1] ?? "";
      const [appliesJson, ruleJson] = [...line.matchAll(/'((?:[^']|'')*)'::jsonb/g)].map((m) => JSON.parse(m[1].replace(/''/g, "'")));
      const frequency = /'(monthly|quarterly|annual|one_time)'::public\.service_frequency/.exec(line)?.[1];
      const seedRule = rule(code);
      expect(frequency).toBe(seedRule.frequency);
      expect(parseRuleSpec(ruleJson, seedRule.frequency)).toEqual({ ok: true, value: seedRule.rule });
      expect(parseAppliesTo(appliesJson)).toEqual({ ok: true, value: seedRule.appliesTo });
    }
  });

  it("contains only §16 content, idempotently", () => {
    const inserts = [...sql.matchAll(/insert into public\.(\w+)/g)].map((m) => m[1]);
    expect(inserts).toEqual(["due_date_rules", "due_date_overrides", "statutory_parameters"]);
    expect(sql.match(/on conflict \(code\) do nothing;/g)).toHaveLength(1);
    expect(sql).toContain("on conflict (rule_code, period_label) do nothing;");
    expect(sql).toContain("on conflict (key, effective_from) do nothing;");
    expect(sql).not.toMatch(/insert into public\.(clients|profiles|employees|tasks|invoices)/);
    expect(sql).toContain("('ITR_AUDIT', 'AY 2026-27', '2026-10-31'::date, '2026-11-21'::date");
    expect(sql).toContain("('TAX_AUDIT_REPORT', 'AY 2026-27', '2026-09-30'::date, '2026-10-21'::date");
  });

  it("escapes quotes in SQL text", () => {
    expect(sqlText("partner's")).toBe("'partner''s'");
    expect(sqlText(null)).toBe("null");
  });
});

// =================================================================================================
describe("parsing and validation (§5.12)", () => {
  it("refuses unknown keys, wrong frequencies and impossible values", () => {
    expect(parseRuleSpec({ monthOffset: 1, day: 20, dya: 3 }, "monthly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ monthOffset: 1, day: 20 }, "quarterly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ monthOffset: 1, day: 32 }, "monthly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ fixed: "13-01", yearOffset: 1 }, "annual")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ fixed: "02-30", yearOffset: 1 }, "annual")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ fixed: "02-29", yearOffset: 1 }, "annual")).toMatchObject({ ok: true });
    expect(parseRuleSpec({ monthOffset: 1, day: 13, monthsOfQuarter: [4] }, "monthly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ afterQuarterEnd: false, monthOffset: 1, day: 13 }, "quarterly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ afterQuarterEnd: true, monthOffset: 1, day: 24, stateDays: [{ day: 22, states: ["290"] }] }, "quarterly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ everyNYears: 3, fixed: "06-30", per: "PAN" }, "annual")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ afterEvent: "", days: 15 }, "annual")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ monthOffset: 1, day: 20, periodLabel: "AY" }, "monthly")).toMatchObject({ ok: false });
    expect(parseRuleSpec(null, "monthly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ day: 20 }, "monthly")).toMatchObject({ ok: false });
    expect(parseRuleSpec({ fixed: "07-31", yearOffset: 1 }, "one_time")).toMatchObject({ ok: false });
  });

  it("accepts the spec's example shapes (§5.12)", () => {
    expect(parseRuleSpec({ monthOffset: 1, day: 20 }, "monthly")).toEqual({ ok: true, value: { monthOffset: 1, day: 20 } });
    expect(parseRuleSpec({ afterEvent: "AGM", days: 30 }, "annual")).toEqual({ ok: true, value: { afterEvent: "AGM", days: 30 } });
    expect(parseRuleSpec({ fixed: "07-31", yearOffset: 1 }, "annual")).toEqual({ ok: true, value: { fixed: "07-31", yearOffset: 1 } });
    expect(parseRuleSpec({ everyNYears: 3, fixed: "06-30", per: "DIN" }, "annual")).toMatchObject({ ok: true });
    expect(ruleKind(rule("FORM16A").rule)).toBe("afterRuleDue");
    expect(ruleKind(rule("AOC4_OPC").rule)).toBe("afterPeriodEnd");
    expect(ruleKind(rule("DIR3_KYC_WEB").rule)).toBe("everyNYears");
  });

  it("reads applies_to strictly, with `state` as a one-state alias (§6.7 'applies_to.state')", () => {
    expect(parseAppliesTo({ state: "27" })).toEqual({ ok: true, value: { states: ["27"] } });
    expect(parseAppliesTo(null)).toEqual({ ok: true, value: {} });
    expect(parseAppliesTo({ services: ["gst"] })).toMatchObject({ ok: false });
    expect(parseAppliesTo({ serviceTypes: ["vat"] })).toMatchObject({ ok: false });
    expect(parseAppliesTo({ gstScheme: "annual" })).toMatchObject({ ok: false });
    expect(parseAppliesTo({ minTurnover: -1 })).toMatchObject({ ok: false });
    expect(parseAppliesTo({ auditCase: "yes" })).toMatchObject({ ok: false });
  });

  it("reads database rows and says what is wrong with a bad one", () => {
    const good = dueDateRuleRow(rule("PF_ESIC"));
    expect(parseDueDateRuleRow({ ...good, is_active: null, verified: null })).toMatchObject({ ok: true, value: { isActive: true, verified: false } });
    expect(parseDueDateRuleRow({ ...good, compliance_type: "vat" })).toMatchObject({ ok: false });
    expect(parseDueDateRuleRow({ ...good, effective_to: "2020-01-01" })).toEqual({ ok: false, error: "Rule PF_ESIC: effective to is before effective from." });
    expect(parseDueDateRuleRow({ ...good, reminder_days: -1 })).toMatchObject({ ok: false });
    expect(parseDueDateRuleRow({ ...good, rule: { monthOffset: 1 } })).toMatchObject({ ok: false });
    const ov = parseDueDateOverrideRow({ rule_code: "ITR_AUDIT", period_label: " AY 2026-27 ", original_due: "2026-10-31", extended_due: "2026-11-21", source_ref: "CBDT Circular 07/2026 dated 28 Sep 2026" });
    expect(ov).toMatchObject({ ok: true, value: { periodLabel: "AY 2026-27", id: null } });
    expect(parseDueDateOverrideRow({ rule_code: "ITR_AUDIT", period_label: "AY 2026-27", original_due: "2026-10-31", extended_due: "2026-11-31", source_ref: "x" })).toMatchObject({ ok: false });
    expect(parseDueDateOverrideRow({ rule_code: "ITR_AUDIT", period_label: "AY 2026-27", original_due: "2026-10-31", extended_due: "2026-11-21", source_ref: " " })).toMatchObject({ ok: false });
  });
});

// =================================================================================================
describe("GST (§6.7)", () => {
  it("monthly filers: GSTR-1 on the 11th and GSTR-3B on the 20th of the next month", () => {
    const ev = gen({ serviceTypes: ["gst"], gstScheme: "monthly" });
    expect(one(ev, "GSTR1_MONTHLY", "Oct 2026").dueDate).toBe("2026-11-11");
    expect(one(ev, "GSTR3B_MONTHLY", "Oct 2026").dueDate).toBe("2026-11-20");
    for (const e of byRule(ev, "GSTR3B_MONTHLY")) expect(e.dueDate.slice(8)).toBe("20");
    for (const e of byRule(ev, "GSTR1_MONTHLY")) expect(e.dueDate.slice(8)).toBe("11");
    expect(byRule(ev, "GSTR1_QRMP")).toHaveLength(0);
    expect(byRule(ev, "PMT06")).toHaveLength(0);
  });

  it("QRMP in Karnataka (29): GSTR-3B lands on the 22nd after the quarter (§18.3)", () => {
    const ev = gen({ serviceTypes: ["gst"], gstScheme: "qrmp", stateCode: "29" });
    expect(one(ev, "GSTR3B_QRMP", "Q2 2026-27").dueDate).toBe("2026-10-22");
    expect(one(ev, "GSTR3B_QRMP", "Q3 2026-27").dueDate).toBe("2027-01-22");
    expect(one(ev, "GSTR3B_QRMP", "Q4 2026-27").dueDate).toBe("2027-04-22");
    const all = byRule(ev, "GSTR3B_QRMP");
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const e of all) expect(e.dueDate.slice(8)).toBe("22");
    expect(byRule(ev, "GSTR3B_MONTHLY")).toHaveLength(0);
  });

  it("QRMP GSTR-3B is the 22nd for state codes 22–37 and the 24th elsewhere (§6.6)", () => {
    const day = (stateCode: string | null) => one(gen({ serviceTypes: ["gst"], gstScheme: "qrmp", stateCode }), "GSTR3B_QRMP", "Q3 2026-27").dueDate;
    expect(day("27")).toBe("2027-01-22"); // Maharashtra
    expect(day("36")).toBe("2027-01-22"); // Telangana
    expect(day("22")).toBe("2027-01-22");
    expect(day("37")).toBe("2027-01-22");
    expect(day("07")).toBe("2027-01-24"); // Delhi
    expect(day("19")).toBe("2027-01-24"); // West Bengal
    expect(day("21")).toBe("2027-01-24");
    expect(day("38")).toBe("2027-01-24");
    const unknown = one(gen({ serviceTypes: ["gst"], gstScheme: "qrmp", stateCode: null }), "GSTR3B_QRMP", "Q3 2026-27");
    expect(unknown.dueDate).toBe("2027-01-22");
    expect(unknown.notes).toContain("state isn't recorded");
  });

  it("QRMP: GSTR-1 on the 13th after the quarter; PMT-06 on the 25th for months 1–2 only; IFF only when opted in", () => {
    const ev = gen({ serviceTypes: ["gst"], gstScheme: "qrmp" });
    expect(one(ev, "GSTR1_QRMP", "Q3 2026-27").dueDate).toBe("2027-01-13");
    expect(one(ev, "PMT06", "Oct 2026").dueDate).toBe("2026-11-25");
    expect(one(ev, "PMT06", "Nov 2026").dueDate).toBe("2026-12-25");
    expect(ev.find((e) => e.ruleCode === "PMT06" && e.filingPeriod === "Dec 2026")).toBeUndefined();
    for (const e of byRule(ev, "PMT06")) expect(["Jan", "Feb", "Apr", "May", "Jul", "Aug", "Oct", "Nov"]).toContain(e.filingPeriod.slice(0, 3));
    expect(byRule(ev, "IFF")).toHaveLength(0);
    const iff = gen({ serviceTypes: ["gst"], gstScheme: "qrmp", optIns: ["iff"] });
    expect(one(iff, "IFF", "Oct 2026").dueDate).toBe("2026-11-13");
    expect(iff.find((e) => e.ruleCode === "IFF" && e.filingPeriod === "Dec 2026")).toBeUndefined();
  });

  it("derives the scheme from turnover when none is recorded (§6.6)", () => {
    expect(byRule(gen({ serviceTypes: ["gst"], gstScheme: null, turnover: toPaise(5 * CRORE) }), "GSTR3B_QRMP").length).toBeGreaterThan(0);
    expect(byRule(gen({ serviceTypes: ["gst"], gstScheme: null, turnover: toPaise(5 * CRORE) + 1 }), "GSTR3B_MONTHLY").length).toBeGreaterThan(0);
    expect(byRule(gen({ serviceTypes: ["gst"], gstScheme: null, turnover: null }), "GSTR3B_MONTHLY").length).toBeGreaterThan(0);
    // a QRMP choice above the limit can't stand: monthly dates
    const above = gen({ serviceTypes: ["gst"], gstScheme: "qrmp", turnover: toPaise(6 * CRORE) });
    expect(byRule(above, "GSTR3B_QRMP")).toHaveLength(0);
    expect(byRule(above, "GSTR3B_MONTHLY").length).toBeGreaterThan(0);
    expect(effectiveGstScheme({ gstScheme: "monthly", turnover: toPaise(CRORE) })).toBe("monthly");
    expect(effectiveGstScheme({ gstScheme: "composition", turnover: null })).toBe("composition");
  });

  it("composition: CMP-08 on the 18th after the quarter and GSTR-4 on 30 April after the FY", () => {
    const ev = gen({ serviceTypes: ["gst"], gstScheme: "composition", turnover: toPaise(1 * CRORE) });
    expect(ev.find((e) => e.ruleCode === "CMP08" && e.filingPeriod === "Q2 2026-27")).toBeUndefined(); // 18 Oct 2026 has passed
    expect(one(ev, "CMP08", "Q3 2026-27").dueDate).toBe("2027-01-18");
    expect(one(ev, "CMP08", "Q4 2026-27").dueDate).toBe("2027-04-18");
    expect(one(ev, "GSTR4", "FY 2026-27").dueDate).toBe("2027-04-30");
    expect(byRule(ev, "GSTR1_MONTHLY")).toHaveLength(0);
    expect(byRule(ev, "GSTR3B_QRMP")).toHaveLength(0);
    expect(byRule(ev, "GSTR9")).toHaveLength(0);
  });

  it("GSTR-7 / GSTR-8 on the 10th of the next month, for deductors and collectors only", () => {
    expect(byRule(gen({ serviceTypes: ["gst"] }), "GSTR7")).toHaveLength(0);
    const ev = gen({ serviceTypes: ["gst"], optIns: ["gst_tds", "gst_tcs"] });
    expect(one(ev, "GSTR7", "Oct 2026").dueDate).toBe("2026-11-10");
    expect(one(ev, "GSTR8", "Oct 2026").dueDate).toBe("2026-11-10");
  });

  it("GSTR-9 above ₹2 crore and GSTR-9C above ₹5 crore, on 31 December after the FY", () => {
    const at2 = gen({ serviceTypes: ["gst"], turnover: toPaise(2 * CRORE) });
    expect(byRule(at2, "GSTR9")).toHaveLength(0);
    const above2 = gen({ serviceTypes: ["gst"], turnover: toPaise(2 * CRORE) + 1 });
    expect(one(above2, "GSTR9", "FY 2025-26").dueDate).toBe("2026-12-31");
    expect(one(above2, "GSTR9", "FY 2026-27").dueDate).toBe("2027-12-31");
    expect(byRule(above2, "GSTR9C")).toHaveLength(0);
    expect(byRule(gen({ serviceTypes: ["gst"], turnover: toPaise(5 * CRORE) }), "GSTR9C")).toHaveLength(0);
    expect(one(gen({ serviceTypes: ["gst"], turnover: toPaise(5 * CRORE) + 1 }), "GSTR9C", "FY 2025-26").dueDate).toBe("2026-12-31");
  });

  it("with no turnover recorded, turnover-band returns are included to be safe, with a note", () => {
    const ev = gen({ serviceTypes: ["gst"], turnover: null });
    const g9 = one(ev, "GSTR9", "FY 2025-26");
    expect(g9.notes).toContain("Turnover isn't recorded");
    expect(byRule(ev, "GSTR9C").length).toBeGreaterThan(0);
  });

  it("GST returns carry the three-year filing bar from the July 2025 period; payments don't", () => {
    const ev = gen({ serviceTypes: ["gst"], gstScheme: "qrmp" });
    const q3 = one(ev, "GSTR3B_QRMP", "Q3 2026-27");
    expect(q3.filingBarDate).toBe("2030-01-22");
    expect(byRule(ev, "PMT06").every((e) => e.filingBarDate === null)).toBe(true);
    const old = gen({ serviceTypes: ["gst"], gstScheme: "monthly" }, { today: "2025-07-01", from: "2025-07-01" });
    expect(one(old, "GSTR3B_MONTHLY", "Jun 2025").filingBarDate).toBeNull();
    expect(one(old, "GSTR3B_MONTHLY", "Jul 2025").filingBarDate).toBe("2028-08-20");
  });
});

// =================================================================================================
describe("Income tax, FY 2025-26 / AY 2026-27 (§6.7)", () => {
  const april = { today: "2026-04-01" };

  it("ITR-1 / ITR-2 (non-audit): 31 July 2026, labelled AY 2026-27", () => {
    const e = one(gen({ serviceTypes: ["income_tax"], entityType: "individual" }, april), "ITR_NON_AUDIT_1_2", "AY 2026-27");
    expect(e).toMatchObject({ dueDate: "2026-07-31", formCode: "ITR", financialYear: "2025-26", type: "itr", dedupeKey: "c1|ITR|AY 2026-27" });
    expect(e.title).toBe("Income tax return, non-audit (ITR-1 / ITR-2) for AY 2026-27");
  });

  it("ITR-3 / ITR-4 (non-audit business or profession): 31 August (§14), every year", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "proprietorship" }, april);
    expect(one(ev, "ITR_NON_AUDIT_3_4", "AY 2026-27").dueDate).toBe("2026-08-31");
    expect(one(ev, "ITR_NON_AUDIT_3_4", "Tax year 2026-27").dueDate).toBe("2027-08-31");
    expect(byRule(ev, "ITR_NON_AUDIT_1_2")).toHaveLength(0);
    expect(byRule(ev, "ITR_AUDIT")).toHaveLength(0);
    expect(rule("ITR_NON_AUDIT_3_4").verified).toBe(false);
  });

  it("tax audit cases: report 30 Sep → 21 Oct 2026 and ITR 31 Oct → 21 Nov 2026 by the circular (overrides)", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "proprietorship", taxAuditApplicable: "yes" }, april);
    const report = one(ev, "TAX_AUDIT_REPORT", "AY 2026-27");
    expect(report).toMatchObject({
      dueDate: "2026-10-21",
      originalDueDate: "2026-09-30",
      overrideRef: "CBDT Circular 07/2026 dated 28 Sep 2026",
      formCode: "Form 3CA/3CB-3CD",
      type: "audit",
    });
    expect(report.notes).toContain("Extended from 30 Sep 2026 to 21 Oct 2026 by CBDT Circular 07/2026 dated 28 Sep 2026.");
    expect(one(ev, "ITR_AUDIT", "AY 2026-27")).toMatchObject({ dueDate: "2026-11-21", originalDueDate: "2026-10-31", dedupeKey: "c1|ITR|AY 2026-27" });
    expect(byRule(ev, "ITR_NON_AUDIT_3_4")).toHaveLength(0);
    // the next year has no circular: the rule's own dates, and the 2025 Act's Form 26
    expect(one(ev, "TAX_AUDIT_REPORT", "Tax year 2026-27")).toMatchObject({ dueDate: "2027-09-30", originalDueDate: null, formCode: "Form 26", overrideRef: null });
    expect(one(ev, "ITR_AUDIT", "Tax year 2026-27").dueDate).toBe("2027-10-31");
  });

  it("companies are audit cases for the ITR date, without a tax audit report unless indicated", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "pvt_ltd", taxAuditApplicable: "no" });
    expect(one(ev, "ITR_AUDIT", "AY 2026-27").dueDate).toBe("2026-11-21");
    expect(byRule(ev, "TAX_AUDIT_REPORT")).toHaveLength(0);
    expect(isAuditCase({ entityType: "pvt_ltd", taxAuditApplicable: null })).toBe(true);
    expect(isAuditCase({ entityType: "pvt_ltd", taxAuditApplicable: null, statutoryAudit: false })).toBe(false);
    expect(isAuditCase({ entityType: "llp", taxAuditApplicable: "no", statutoryAudit: true })).toBe(true);
    expect(isAuditCase({ entityType: "proprietorship", taxAuditApplicable: true })).toBe(true);
    expect(isAuditCase({ entityType: "proprietorship", taxAuditApplicable: "review" })).toBe(false);
  });

  it("'review' and unknown audit status use the earlier non-audit date", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "proprietorship", taxAuditApplicable: "review" }, april);
    expect(one(ev, "ITR_NON_AUDIT_3_4", "AY 2026-27").dueDate).toBe("2026-08-31");
  });

  it("non-audit firms, LLPs and AOPs: 31 July [verify]", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "partnership" }, april);
    expect(one(ev, "ITR_NON_AUDIT_5", "AY 2026-27").dueDate).toBe("2026-07-31");
  });

  it("transfer-pricing cases: Form 3CEB 31 October and the ITR 30 November (no audit-case ITR)", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "pvt_ltd", isTpCase: true, taxAuditApplicable: "yes" }, april);
    expect(one(ev, "FORM_3CEB", "AY 2026-27").dueDate).toBe("2026-10-31");
    expect(one(ev, "ITR_TP", "AY 2026-27").dueDate).toBe("2026-11-30");
    expect(byRule(ev, "ITR_AUDIT")).toHaveLength(0);
    expect(new Set(ev.map((e) => e.dedupeKey)).size).toBe(ev.length);
  });

  it("belated, revised and updated returns only when asked for", () => {
    const plain = gen({ serviceTypes: ["income_tax"], entityType: "individual" });
    expect(plain.filter((e) => ["ITR_BELATED", "ITR_REVISED", "ITR_UPDATED"].includes(e.ruleCode ?? ""))).toHaveLength(0);
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "individual", optIns: ["itr_belated", "itr_revised", "itr_updated"] });
    expect(one(ev, "ITR_BELATED", "AY 2026-27")).toMatchObject({ dueDate: "2026-12-31", formCode: "ITR (belated)" });
    expect(one(ev, "ITR_REVISED", "AY 2026-27").dueDate).toBe("2027-03-31");
    expect(one(ev, "ITR_REVISED", "AY 2026-27").notes).toContain("fee applies after 9 months");
    expect(one(ev, "ITR_UPDATED", "AY 2022-23").dueDate).toBe("2027-03-31"); // FY 2021-22: 48 months after AY 2022-23 ends
  });
});

describe("Income tax, all years (§6.7)", () => {
  it("advance tax: 15 Jun 15% · 15 Sep 45% · 15 Dec 75% · 15 Mar 100%", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "individual" }, { today: "2026-04-01" });
    expect(one(ev, "ADVANCE_TAX_Q1", "Q1 2026-27").dueDate).toBe("2026-06-15");
    expect(one(ev, "ADVANCE_TAX_Q2", "Q2 2026-27").dueDate).toBe("2026-09-15");
    expect(one(ev, "ADVANCE_TAX_Q3", "Q3 2026-27").dueDate).toBe("2026-12-15");
    const q4 = one(ev, "ADVANCE_TAX_Q4", "Q4 2026-27");
    expect(q4.dueDate).toBe("2027-03-15");
    expect(q4.notes).toContain("Cumulative 100%");
    expect(one(ev, "ADVANCE_TAX_Q2", "Q2 2026-27").notes).toBe("Cumulative 45% of the year's estimated tax.");
    expect(one(ev, "ADVANCE_TAX_Q1", "Q1 2026-27").dedupeKey).toBe("c1|Advance tax|Q1 2026-27");
  });

  it("presumptive (s.44AD/44ADA) cases pay 100% by 15 March: one instalment", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "proprietorship", isPresumptive: true }, { today: "2026-04-01" });
    expect(byRule(ev, "ADVANCE_TAX_Q1")).toHaveLength(0);
    expect(byRule(ev, "ADVANCE_TAX_Q2")).toHaveLength(0);
    expect(byRule(ev, "ADVANCE_TAX_Q3")).toHaveLength(0);
    expect(one(ev, "ADVANCE_TAX_Q4", "Q4 2026-27").dueDate).toBe("2027-03-15");
  });

  it("TDS deposit: the 7th of the next month, but March by 30 April (§14)", () => {
    const ev = gen({ serviceTypes: ["tds"] });
    expect(one(ev, "TDS_DEPOSIT", "Mar 2027").dueDate).toBe("2027-04-30");
    expect(one(ev, "TDS_DEPOSIT", "Feb 2027").dueDate).toBe("2027-03-07");
    expect(one(ev, "TDS_DEPOSIT", "Apr 2027").dueDate).toBe("2027-05-07");
    expect(one(ev, "TDS_DEPOSIT", "Dec 2026").dueDate).toBe("2027-01-07");
    for (const e of byRule(ev, "TDS_DEPOSIT")) expect(e.dueDate.slice(8)).toBe(e.filingPeriod.startsWith("Mar") ? "30" : "07");
  });

  it("TDS statements: Q1 31 Jul · Q2 31 Oct · Q3 31 Jan · Q4 31 May; Forms 138/140/144 from tax year 2026-27", () => {
    const ev = gen({ serviceTypes: ["tds"] }, { today: "2026-04-01" });
    const q4Old = one(ev, "TDS_RETURN_Q4", "Q4 2025-26");
    expect(q4Old).toMatchObject({ dueDate: "2026-05-31", formCode: "24Q/26Q/27Q" });
    expect(one(ev, "TDS_RETURN_Q1", "Q1 2026-27")).toMatchObject({ dueDate: "2026-07-31", formCode: "Form 138/140/144" });
    expect(one(ev, "TDS_RETURN_Q2", "Q2 2026-27").dueDate).toBe("2026-10-31");
    expect(one(ev, "TDS_RETURN_Q3", "Q3 2026-27").dueDate).toBe("2027-01-31");
    // 31 May 2027 is past the 13-month window from 1 Apr 2026; it comes in with a later top-up
    expect(ev.find((e) => e.ruleCode === "TDS_RETURN_Q4" && e.filingPeriod === "Q4 2026-27")).toBeUndefined();
    expect(one(gen({ serviceTypes: ["tds"] }), "TDS_RETURN_Q4", "Q4 2026-27").dueDate).toBe("2027-05-31");
    // each quarterly rule only gives its own quarter
    expect(byRule(ev, "TDS_RETURN_Q1").every((e) => e.filingPeriod.startsWith("Q1"))).toBe(true);
  });

  it("TDS certificates: Form 16 / 130 by 15 June; Form 16A / 131 within 15 days of the statement due date", () => {
    const ev = gen({ serviceTypes: ["tds"] }, { today: "2026-04-01" });
    expect(one(ev, "FORM16", "FY 2025-26")).toMatchObject({ dueDate: "2026-06-15", formCode: "Form 16" });
    expect(one(ev, "FORM16", "FY 2026-27")).toMatchObject({ dueDate: "2027-06-15", formCode: "Form 130" });
    expect(one(ev, "FORM16A", "Q4 2025-26")).toMatchObject({ dueDate: "2026-06-15", formCode: "Form 16A" });
    expect(one(ev, "FORM16A", "Q1 2026-27")).toMatchObject({ dueDate: "2026-08-15", formCode: "Form 131" });
    expect(one(ev, "FORM16A", "Q2 2026-27").dueDate).toBe("2026-11-15");
    expect(one(ev, "FORM16A", "Q3 2026-27").dueDate).toBe("2027-02-15");
  });
});

// =================================================================================================
describe("Companies Act and LLP Act (§6.7)", () => {
  const company: Partial<CalendarClientProfile> = { serviceTypes: ["company_law"], entityType: "pvt_ltd" };
  const sept = { today: "2026-09-01" };

  it("AGM by 30 September; ADT-1, AOC-4 and MGT-7 provisional at +15, +30 and +60 days until the AGM date is entered", () => {
    const ev = gen(company, sept);
    const agm = one(ev, "AGM", "FY 2025-26");
    expect(agm).toMatchObject({ dueDate: "2026-09-30", provisional: false, agmDate: null, lateFeePerDayPaise: null });
    expect(agm.notes).toContain("Enter the AGM date on this event");
    const adt = one(ev, "ADT1", "FY 2025-26");
    expect(adt).toMatchObject({ dueDate: "2026-10-15", provisional: true, agmDate: null, dedupeKey: "c1|ADT-1|FY 2025-26" });
    expect(adt.notes).toBe("Provisional: dated from an AGM on 30 Sep 2026. Enter the actual date on the AGM event to fix this date.");
    expect(one(ev, "AOC4", "FY 2025-26")).toMatchObject({ dueDate: "2026-10-30", provisional: true });
    expect(one(ev, "MGT7", "FY 2025-26")).toMatchObject({ dueDate: "2026-11-29", provisional: true, formCode: "MGT-7/MGT-7A" });
  });

  it("AGM-linked dates follow the AGM date once it is entered (§14)", () => {
    const ev = gen({ ...company, agmDates: { "2025-26": "2026-09-20" } }, sept);
    expect(one(ev, "ADT1", "FY 2025-26")).toMatchObject({ dueDate: "2026-10-05", provisional: false, agmDate: "2026-09-20", notes: null });
    expect(one(ev, "AOC4", "FY 2025-26")).toMatchObject({ dueDate: "2026-10-20", provisional: false, agmDate: "2026-09-20" });
    expect(one(ev, "MGT7", "FY 2025-26")).toMatchObject({ dueDate: "2026-11-19", provisional: false });
    const agm = one(ev, "AGM", "FY 2025-26");
    expect(agm).toMatchObject({ dueDate: "2026-09-30", agmDate: "2026-09-20", notes: "Held on 20 Sep 2026." });
    // the next FY has no AGM date yet: provisional again
    expect(one(ev, "AOC4", "FY 2026-27")).toMatchObject({ dueDate: "2027-10-30", provisional: true });
  });

  it("a later AGM within an extension moves the provisional dates with it", () => {
    const ext: DueDateOverride[] = [...OVERRIDES, { ruleCode: "AGM", periodLabel: "FY 2025-26", originalDue: "2026-09-30", extendedDue: "2026-12-31", sourceRef: "ROC extension order" }];
    const ev = gen(company, sept, ext);
    expect(one(ev, "AGM", "FY 2025-26")).toMatchObject({ dueDate: "2026-12-31", originalDueDate: "2026-09-30" });
    expect(one(ev, "AOC4", "FY 2025-26").dueDate).toBe("2027-01-30");
  });

  it("One Person Company: no AGM; AOC-4 within 180 days of the FY end", () => {
    const ev = gen({ ...company, isOpc: true }, { today: "2026-04-01" });
    expect(byRule(ev, "AGM")).toHaveLength(0);
    expect(byRule(ev, "AOC4")).toHaveLength(0);
    expect(one(ev, "AOC4_OPC", "FY 2025-26")).toMatchObject({ dueDate: "2026-09-27", formCode: "AOC-4" });
    const mgt = one(ev, "MGT7", "FY 2025-26");
    expect(mgt).toMatchObject({ dueDate: "2026-11-29", provisional: false });
    expect(mgt.notes).toContain("Dated from the last date for an AGM");
  });

  it("DPT-3 30 June; MSME-1 31 October (Apr–Sep) and 30 April (Oct–Mar)", () => {
    const ev = gen(company, { today: "2026-04-01" });
    expect(one(ev, "DPT3", "FY 2025-26").dueDate).toBe("2026-06-30");
    const h1 = one(ev, "MSME1_H1", "H1 2026-27");
    expect(h1).toMatchObject({ dueDate: "2026-10-31", periodStart: "2026-04-01", periodEnd: "2026-09-30" });
    const h2 = one(ev, "MSME1_H2", "H2 2025-26");
    expect(h2).toMatchObject({ dueDate: "2026-04-30", periodStart: "2025-10-01", periodEnd: "2026-03-31" });
  });

  it("LLPs: Form 11 by 30 May and Form 8 by 30 October; no company forms", () => {
    const ev = gen({ serviceTypes: ["company_law"], entityType: "llp" }, { today: "2026-04-01" });
    expect(one(ev, "LLP_FORM11", "FY 2025-26").dueDate).toBe("2026-05-30");
    expect(one(ev, "LLP_FORM8", "FY 2025-26").dueDate).toBe("2026-10-30");
    expect(byRule(ev, "AGM")).toHaveLength(0);
    expect(byRule(ev, "AOC4")).toHaveLength(0);
  });

  it("ROC events carry the ₹100 per day late fee", () => {
    const ev = gen(company, sept);
    expect(one(ev, "AOC4", "FY 2025-26").lateFeePerDayPaise).toBe(100_00);
    expect(one(ev, "DPT3", "FY 2026-27").lateFeePerDayPaise).toBe(100_00);
  });
});

describe("DIR-3 KYC Web: once every three financial years, by 30 June (§6.7, §14)", () => {
  const roc = (dins: CalendarClientProfile["dins"], today = "2027-04-01") => gen({ serviceTypes: ["company_law"], dins }, { today });

  it("the next due year is three FYs after the last filing", () => {
    expect(dir3KycNextDueFy("2025-26")).toBe("2028-29");
    expect(dir3KycNextDueFy("2026-27", 3)).toBe("2029-30");
    const ev = roc([{ din: "01234567", lastKycFiledFy: "2025-26" }]);
    const e = one(ev, "DIR3_KYC_WEB", "FY 2028-29 (DIN 01234567)");
    expect(e).toMatchObject({ dueDate: "2028-06-30", din: "01234567", provisional: false, dedupeKey: "c1|DIR-3 KYC Web|FY 2028-29 (DIN 01234567)" });
  });

  it("not due in the two years in between", () => {
    const ev = roc([{ din: "01234567", lastKycFiledFy: "2025-26" }], "2026-04-01");
    expect(byRule(ev, "DIR3_KYC_WEB")).toHaveLength(0); // 30 Jun 2028 is past the end of FY 2027-28
  });

  it("tracks each DIN separately, with the director's name in the title", () => {
    const ev = roc([
      { din: "01234567", name: "A. Rao", lastKycFiledFy: "2025-26" },
      { din: "07654321", lastKycFiledFy: "2026-27" },
    ], "2028-04-01");
    const kyc = byRule(ev, "DIR3_KYC_WEB");
    expect(kyc.map((e) => e.dueDate).sort()).toEqual(["2028-06-30", "2029-06-30"]);
    expect(kyc.find((e) => e.din === "01234567")?.title).toBe("Director KYC (DIR-3 KYC Web) for FY 2028-29 (DIN 01234567, A. Rao)");
  });

  it("an explicit next due year wins; an overdue KYC stays on the calendar", () => {
    expect(one(roc([{ din: "1", nextDueFy: "2027-28" }]), "DIR3_KYC_WEB", "FY 2027-28 (DIN 1)").dueDate).toBe("2027-06-30");
    const overdue = roc([{ din: "2", lastKycFiledFy: "2023-24" }], "2026-10-22");
    expect(one(overdue, "DIR3_KYC_WEB", "FY 2026-27 (DIN 2)").dueDate).toBe("2026-06-30");
  });

  it("with no filing history, the next 30 June, provisional", () => {
    const e = one(roc([{ din: "3" }], TODAY), "DIR3_KYC_WEB", "FY 2027-28 (DIN 3)");
    expect(e).toMatchObject({ dueDate: "2027-06-30", provisional: true });
    expect(e.notes).toContain("Record the last filing year on the DIN register");
  });

  it("the triennial rule is in force from 31 March 2026 only", () => {
    expect(byRule(roc([{ din: "4", lastKycFiledFy: "2021-22" }], TODAY), "DIR3_KYC_WEB")).toHaveLength(0); // would be FY 2024-25
  });
});

describe("Labour and state (§6.7)", () => {
  it("PF and ESIC on the 15th of the next month", () => {
    const ev = gen({ serviceTypes: ["payroll"], stateCode: "27" });
    expect(one(ev, "PF_ESIC", "Oct 2026").dueDate).toBe("2026-11-15");
    expect(byRule(ev, "PT_KA_MONTHLY")).toHaveLength(0);
    expect(byRule(ev, "PT_KA_ANNUAL")).toHaveLength(0);
  });

  it("Karnataka professional tax: the 20th of the next month, and the enrolment payment by 30 April [verify]", () => {
    const ev = gen({ serviceTypes: ["payroll"], stateCode: "29" });
    expect(one(ev, "PT_KA_MONTHLY", "Oct 2026").dueDate).toBe("2026-11-20");
    expect(one(ev, "PT_KA_ANNUAL", "FY 2027-28").dueDate).toBe("2027-04-30");
    expect(rule("PT_KA_MONTHLY").verified).toBe(false);
  });
});

// =================================================================================================
describe("generation mechanics (§6.7, §7.7)", () => {
  const all: Partial<CalendarClientProfile> = {
    serviceTypes: ["gst", "income_tax", "tds", "payroll", "company_law", "audit"],
    entityType: "pvt_ltd",
    taxAuditApplicable: "yes",
    dins: [{ din: "01234567" }],
  };

  it("is idempotent: the same inputs give the same events, one per dedupe key", () => {
    const a = gen(all);
    const b = gen(all);
    expect(b).toEqual(a);
    expect(new Set(a.map((e) => e.dedupeKey)).size).toBe(a.length);
    for (const e of a) expect(e.dedupeKey).toBe(`c1|${e.formCode}|${e.filingPeriod}`);
  });

  it("monthly and quarterly cadences cover the next 13 months; annual ones the current and next FY", () => {
    const ev = gen(all);
    const horizon = addMonths(TODAY, 13);
    for (const e of ev) {
      expect(e.dueDate >= TODAY).toBe(true);
      const r = rule(e.ruleCode ?? "");
      if (r.frequency === "annual") expect(e.dueDate <= "2028-03-31").toBe(true);
      else expect(e.dueDate <= horizon).toBe(true);
    }
    const months = byRule(ev, "TDS_DEPOSIT").map((e) => e.filingPeriod);
    expect(months[0]).toBe("Oct 2026");
    expect(months.at(-1)).toBe("Oct 2027"); // 7 Nov 2027 is within 22 Nov 2027
    expect(byRule(ev, "TDS_DEPOSIT")).toHaveLength(13);
    expect(one(ev, "ITR_AUDIT", "Tax year 2026-27").dueDate).toBe("2027-10-31");
    expect(ev.find((e) => e.ruleCode === "ITR_AUDIT" && e.filingPeriod === "Tax year 2027-28")).toBeUndefined();
    expect(one(ev, "GSTR9", "FY 2026-27").dueDate).toBe("2027-12-31");
  });

  it("a shorter horizon gives fewer periodic events", () => {
    const short = gen(all, { horizonMonths: 3 });
    expect(byRule(short, "TDS_DEPOSIT").map((e) => e.filingPeriod)).toEqual(["Oct 2026", "Nov 2026", "Dec 2026"]);
    expect(() => gen(all, { horizonMonths: 0 })).toThrow(RangeError);
  });

  it("never generates before `from` (default today); an earlier `from` backfills", () => {
    const ev = gen({ serviceTypes: ["gst"], gstScheme: "monthly" });
    expect(ev.find((e) => e.ruleCode === "GSTR3B_MONTHLY" && e.filingPeriod === "Sep 2026")).toBeUndefined();
    const back = gen({ serviceTypes: ["gst"], gstScheme: "monthly" }, { from: "2026-10-01" });
    expect(one(back, "GSTR3B_MONTHLY", "Sep 2026").dueDate).toBe("2026-10-20");
  });

  it("the window is checked on the date in force: an extended date keeps a passed statutory date in", () => {
    const ev = gen({ serviceTypes: ["income_tax"], entityType: "pvt_ltd" }, { today: "2026-11-01" });
    expect(one(ev, "ITR_AUDIT", "AY 2026-27").dueDate).toBe("2026-11-21"); // 31 Oct has passed
    expect(byRule(gen({ serviceTypes: ["income_tax"], entityType: "pvt_ltd" }, { today: "2026-11-01" }, []), "ITR_AUDIT").every((e) => e.filingPeriod !== "AY 2026-27")).toBe(true);
  });

  it("is sorted by due date, then key", () => {
    const ev = gen(all);
    for (let i = 1; i < ev.length; i++) {
      const prev = ev[i - 1];
      const cur = ev[i];
      expect(prev.dueDate < cur.dueDate || (prev.dueDate === cur.dueDate && prev.dedupeKey < cur.dedupeKey)).toBe(true);
    }
  });

  it("only services the client has", () => {
    expect(gen({ serviceTypes: [] })).toEqual([]);
    const ev = gen({ serviceTypes: ["payroll"] });
    expect(new Set(ev.map((e) => e.serviceType))).toEqual(new Set(["payroll"]));
  });

  it("skips inactive rules and periods outside a rule's effective dates", () => {
    const inactive = RULES.map((r) => (r.code === "PF_ESIC" ? { ...r, isActive: false } : r));
    expect(byRule(gen({ serviceTypes: ["payroll"] }, {}, OVERRIDES, inactive), "PF_ESIC")).toHaveLength(0);
    const ended = RULES.map((r) => (r.code === "PF_ESIC" ? { ...r, effectiveTo: "2026-12-31" } : r));
    const months = byRule(gen({ serviceTypes: ["payroll"] }, {}, OVERRIDES, ended), "PF_ESIC").map((e) => e.filingPeriod);
    expect(months.at(-1)).toBe("Dec 2026");
    const later = RULES.map((r) => (r.code === "PF_ESIC" ? { ...r, effectiveFrom: "2027-01-01" } : r));
    expect(byRule(gen({ serviceTypes: ["payroll"] }, {}, OVERRIDES, later), "PF_ESIC")[0].filingPeriod).toBe("Jan 2027");
  });

  it("when two rules give the same key, the earlier date wins", () => {
    const base = rule("PF_ESIC");
    const dup: DueDateRule = { ...base, code: "PF_ESIC_LATE", rule: { monthOffset: 1, day: 25 } };
    const ev = gen({ serviceTypes: ["payroll"] }, {}, [], [dup, base]);
    expect(one(ev, "PF_ESIC", "Oct 2026").dueDate).toBe("2026-11-15");
    // Sep 2026: the earlier date (15 Oct) has passed, and the later rule doesn't sneak in through the window
    expect(byRule(ev, "PF_ESIC_LATE")).toHaveLength(0);
    expect(ev.find((e) => e.filingPeriod === "Sep 2026")).toBeUndefined();
  });

  it("flags Sundays and never moves them (§6.3)", () => {
    const ev = gen({ serviceTypes: ["payroll"] });
    expect(one(ev, "PF_ESIC", "Oct 2026")).toMatchObject({ dueDate: "2026-11-15", fallsOnSunday: true });
    for (const e of gen(all)) expect(e.fallsOnSunday).toBe(isSunday(e.dueDate));
    expect(sundayHint("2026-11-15")).toBe("Falls on a Sunday");
    expect(sundayHint("2026-11-16")).toBeNull();
  });

  it("every event shows its legal source and the engine as its source", () => {
    for (const e of gen(all)) {
      expect(e.sourceRef).toBeTruthy();
      expect(e).toMatchObject({ source: "statutory_engine", isStatutory: true, clientId: "c1" });
      expect(e.reminderDays).toBeGreaterThan(0);
    }
  });

  it("refuses a bad today", () => {
    expect(() => generateEvents(profile(), RULES, OVERRIDES, { today: "22-10-2026" })).toThrow(RangeError);
    expect(() => generateEvents(profile(), RULES, OVERRIDES, { today: TODAY, from: "2026-13-01" })).toThrow(RangeError);
  });

  it("ruleAppliesTo answers for one rule", () => {
    expect(ruleAppliesTo(rule("GSTR3B_QRMP"), profile({ serviceTypes: ["gst"], gstScheme: "qrmp" }))).toBe(true);
    expect(ruleAppliesTo(rule("GSTR3B_QRMP"), profile({ serviceTypes: ["gst"], gstScheme: "monthly" }))).toBe(false);
    expect(ruleAppliesTo(rule("PT_KA_MONTHLY"), profile({ serviceTypes: ["payroll"], stateCode: null }))).toBe(false);
  });

  it("maps to compliance_events columns", () => {
    const e = one(gen(all, { today: "2026-10-01" }), "ITR_AUDIT", "AY 2026-27");
    expect(toComplianceEventInsert(e)).toEqual({
      client_id: "c1",
      type: "itr",
      form_code: "ITR",
      title: "Income tax return, audit case for AY 2026-27",
      description: null,
      financial_year: "2025-26",
      filing_period: "AY 2026-27",
      period_start: "2025-04-01",
      period_end: "2026-03-31",
      due_date: "2026-11-21",
      is_statutory: true,
      source: "statutory_engine",
      reminder_days: 15,
      notes: "Extended from 31 Oct 2026 to 21 Nov 2026 by CBDT Circular 07/2026 dated 28 Sep 2026.",
      dedupe_key: "c1|ITR|AY 2026-27",
      rule_code: "ITR_AUDIT",
      source_ref: rule("ITR_AUDIT").sourceRef,
      original_due_date: "2026-10-31",
      override_id: null,
      agm_date: null,
      is_provisional: false,
    });
  });
});

// =================================================================================================
describe("applyOverride: extensions move only unfiled events (§5.12, §7.7, §14)", () => {
  const circular = OVERRIDES[1]; // ITR_AUDIT AY 2026-27 → 21 Nov 2026
  type Row = { id: string; ruleCode: string | null; filingPeriod: string | null; dueDate: string; originalDueDate?: string | null; status?: "pending" | "completed" | "cancelled"; workflowStatus?: "not_started" | "in_progress" | "filed" | "completed"; overrideRef?: string | null; overrideId?: string | null; fallsOnSunday?: boolean };
  const rows: Row[] = [
    { id: "a", ruleCode: "ITR_AUDIT", filingPeriod: "AY 2026-27", dueDate: "2026-10-31", status: "pending", workflowStatus: "in_progress", fallsOnSunday: false },
    { id: "b", ruleCode: "ITR_AUDIT", filingPeriod: "AY 2026-27", dueDate: "2026-10-31", status: "pending", workflowStatus: "filed" },
    { id: "c", ruleCode: "ITR_AUDIT", filingPeriod: "AY 2026-27", dueDate: "2026-10-31", status: "completed", workflowStatus: "completed" },
    { id: "d", ruleCode: "ITR_AUDIT", filingPeriod: "AY 2026-27", dueDate: "2026-10-31", status: "cancelled" },
    { id: "e", ruleCode: "ITR_AUDIT", filingPeriod: "Tax year 2026-27", dueDate: "2027-10-31" },
    { id: "f", ruleCode: "ITR_TP", filingPeriod: "AY 2026-27", dueDate: "2026-11-30" },
    { id: "g", ruleCode: "ITR_AUDIT", filingPeriod: "AY 2026-27", dueDate: "2026-10-31" },
  ];

  it("moves matching unfiled events, keeps the statutory date and cites the circular", () => {
    const { events, moved } = applyOverride(rows, circular);
    expect(moved.map((m) => m.before.id)).toEqual(["a", "g"]);
    expect(moved[0].note).toBe("Due date moved from 31 Oct 2026 to 21 Nov 2026 by CBDT Circular 07/2026 dated 28 Sep 2026.");
    expect(moved[0].originalMismatch).toBe(false);
    expect(events.find((e) => e.id === "a")).toMatchObject({ dueDate: "2026-11-21", originalDueDate: "2026-10-31", overrideRef: "CBDT Circular 07/2026 dated 28 Sep 2026", fallsOnSunday: false });
    for (const id of ["b", "c", "d", "e", "f"]) expect(events.find((e) => e.id === id)).toEqual(rows.find((r) => r.id === id));
    expect(events.find((e) => e.id === "g")).not.toHaveProperty("fallsOnSunday");
  });

  it("is idempotent, and an edited extension moves events again from their statutory date", () => {
    const once = applyOverride(rows, circular).events;
    expect(applyOverride(once, circular).moved).toHaveLength(0);
    const edited = applyOverride(once, { ...circular, extendedDue: "2026-11-30" });
    expect(edited.moved).toHaveLength(2);
    expect(edited.events.find((e) => e.id === "a")).toMatchObject({ dueDate: "2026-11-30", originalDueDate: "2026-10-31" });
    expect(edited.moved[0].note).toContain("from 21 Nov 2026 to 30 Nov 2026");
  });

  it("flags an event whose statutory date isn't the override's original date", () => {
    const r = applyOverride([{ ruleCode: "ITR_AUDIT", filingPeriod: "AY 2026-27", dueDate: "2026-10-15" }], circular);
    expect(r.moved[0].originalMismatch).toBe(true);
  });

  it("removeOverride moves unfiled events back", () => {
    const moved = applyOverride(rows, circular).events;
    const back = removeOverride(moved, circular);
    expect(back.moved.map((m) => m.before.id)).toEqual(["a", "g"]);
    expect(back.events.find((e) => e.id === "a")).toMatchObject({ dueDate: "2026-10-31", originalDueDate: null, overrideRef: null });
    expect(back.moved[0].note).toBe("Due date moved back from 21 Nov 2026 to 31 Oct 2026: the extension (CBDT Circular 07/2026 dated 28 Sep 2026) was removed.");
  });

  it("applying the override to generated events equals generating with it", () => {
    const p = { serviceTypes: ["income_tax" as const], entityType: "pvt_ltd" as const, taxAuditApplicable: "yes" as const };
    const without = gen(p, { today: "2026-09-01" }, []);
    const applied = OVERRIDES.reduce((evs, o) => applyOverride(evs, o).events, without);
    const withOv = gen(p, { today: "2026-09-01" });
    const pick = (evs: CalendarEvent[]) => evs.map((e) => [e.dedupeKey, e.dueDate, e.originalDueDate, e.overrideRef]);
    expect(pick(applied)).toEqual(pick(withOv));
  });

  it("isUnfiled", () => {
    expect(isUnfiled({})).toBe(true);
    expect(isUnfiled({ status: "pending", workflowStatus: "under_review" })).toBe(true);
    expect(isUnfiled({ status: "pending", workflowStatus: "filed" })).toBe(false);
    expect(isUnfiled({ status: "cancelled" })).toBe(false);
  });
});

describe("planEventSync (idempotent writes)", () => {
  const company = profile({ serviceTypes: ["company_law"] });
  const opts = { today: "2026-09-01" };
  const stored = (e: CalendarEvent, extra: Partial<StoredEvent> = {}): StoredEvent => ({
    id: e.dedupeKey,
    dedupeKey: e.dedupeKey,
    ruleCode: e.ruleCode,
    dueDate: e.dueDate,
    status: "pending",
    workflowStatus: "not_started",
    source: "statutory_engine",
    provisional: e.provisional,
    agmDate: e.agmDate,
    ...extra,
  });

  it("inserts new keys only; a second run changes nothing", () => {
    const first = generateEvents(company, RULES, OVERRIDES, opts);
    const plan = planEventSync([], first);
    expect(plan.insert).toHaveLength(first.length);
    const again = planEventSync(first.map((e) => stored(e)), generateEvents(company, RULES, OVERRIDES, opts));
    expect(again).toEqual({ insert: [], update: [], unchanged: first.length });
  });

  it("firms up provisional AGM-linked dates once the AGM date is entered", () => {
    const before = generateEvents(company, RULES, OVERRIDES, opts).map((e) => stored(e));
    const after = generateEvents({ ...company, agmDates: { "2025-26": "2026-09-20" } }, RULES, OVERRIDES, opts);
    const plan = planEventSync(before, after);
    expect(plan.update.map((u) => u.event.ruleCode).sort()).toEqual(["ADT1", "AOC4", "MGT7"]);
    expect(plan.update.every((u) => u.reason === "The AGM date was entered.")).toBe(true);
  });

  it("moves the ITR when the audit decision changes, but never touches filed or hand-edited events", () => {
    const p = profile({ serviceTypes: ["income_tax"], entityType: "proprietorship" });
    const nonAudit = generateEvents(p, RULES, OVERRIDES, { today: "2026-04-01" });
    const audit = generateEvents({ ...p, taxAuditApplicable: "yes" }, RULES, OVERRIDES, { today: "2026-04-01" });
    const plan = planEventSync(nonAudit.map((e) => stored(e)), audit);
    const itr = plan.update.find((u) => u.event.dedupeKey === "c1|ITR|AY 2026-27");
    expect(itr).toMatchObject({ reason: "A different rule now applies to this client.", event: { dueDate: "2026-11-21" } });
    const filed = planEventSync(nonAudit.map((e) => stored(e, { workflowStatus: "filed" })), audit);
    expect(filed.update).toHaveLength(0);
    const manual = planEventSync(nonAudit.map((e) => stored(e, { source: "manual" })), audit);
    expect(manual.update).toHaveLength(0);
  });
});

// =================================================================================================
describe("flags: GST filing bar, ROC late fee, reminders (§6.7)", () => {
  it("filingBarDate is three years after the due date", () => {
    expect(filingBarDate("2026-10-20")).toBe("2029-10-20");
    expect(filingBarDate("2028-02-29")).toBe("2031-02-28");
    expect(filingBarDate("2026-10-20", 5)).toBe("2031-10-20");
  });

  it("flags an unfiled return within six months of the bar, and past it as barred", () => {
    expect(filingBarStatus("2026-10-20", "2029-04-19")).toEqual({ barDate: "2029-10-20", nearBar: false, barred: false });
    expect(filingBarStatus("2026-10-20", "2029-04-20")).toEqual({ barDate: "2029-10-20", nearBar: true, barred: false });
    expect(filingBarStatus("2026-10-20", "2029-10-20")).toEqual({ barDate: "2029-10-20", nearBar: true, barred: false });
    expect(filingBarStatus("2026-10-20", "2029-10-21")).toEqual({ barDate: "2029-10-20", nearBar: false, barred: true });
    expect(filingBarStatus("2026-10-20", "2029-10-21", { filed: true })).toEqual({ barDate: "2029-10-20", nearBar: false, barred: false });
    expect(filingBarStatus("2026-10-20", "2029-07-01", { params: { years: 3, warnMonths: 2 } }).nearBar).toBe(false);
    expect(isNearFilingBar("2029-10-20", "2029-04-20")).toBe(true);
    expect(isNearFilingBar("2029-10-20", "2029-04-19")).toBe(false);
  });

  it("accrues ₹100 per day per form after the due date", () => {
    expect(lateFeeAccrued("2026-10-30", "2026-10-30")).toEqual({ daysLate: 0, amountPaise: 0 });
    expect(lateFeeAccrued("2026-10-30", "2026-10-01")).toEqual({ daysLate: 0, amountPaise: 0 });
    expect(lateFeeAccrued("2026-10-30", "2026-11-09")).toEqual({ daysLate: 10, amountPaise: 1_000_00 });
    expect(lateFeeAccrued("2026-10-30", "2027-10-30")).toEqual({ daysLate: 365, amountPaise: 36_500_00 });
    expect(lateFeeAccrued("2026-10-30", "2026-11-01", 200_00).amountPaise).toBe(400_00);
    expect(() => lateFeeAccrued("2026-10-30", "2026-11-01", -1)).toThrow(RangeError);
  });

  it("reminderDate and formatDay", () => {
    expect(reminderDate("2026-11-20", 7)).toBe("2026-11-13");
    expect(reminderDate("2026-11-20", 0)).toBe("2026-11-20");
    expect(formatDay("2026-11-21")).toBe("21 Nov 2026");
  });

  it("resolveCalendarParams reads the seed rows and keeps the defaults otherwise", () => {
    const rows: StatutoryParameterRow[] = CALENDAR_SEED_PARAMETERS.map((r) => ({ ...r }));
    expect(resolveCalendarParams(rows, TODAY)).toEqual(CALENDAR_DEFAULTS);
    expect(resolveCalendarParams([], TODAY)).toEqual(CALENDAR_DEFAULTS);
    const custom = resolveCalendarParams([{ key: "roc.late_fee_per_day", value: { amount: 150 }, effectiveFrom: "2026-01-01" }], TODAY);
    expect(custom.rocLateFeePerDayPaise).toBe(150_00);
    const ev = generateEvents(profile({ serviceTypes: ["company_law"] }), RULES, OVERRIDES, { today: TODAY, params: custom });
    expect(one(ev, "AOC4", "FY 2025-26").lateFeePerDayPaise).toBe(150_00);
  });
});

// =================================================================================================
describe("coverage gaps (§7.7)", () => {
  it("flags a monthly service whose deadlines stop soon, naming the last month", () => {
    const events = [
      { type: "gstr_3b" as const, dueDate: "2026-11-20" },
      { type: "gstr_3b" as const, dueDate: "2026-12-20" },
    ];
    expect(coverageGaps([{ serviceType: "gst", frequency: "monthly" }], events, TODAY)).toEqual([
      { serviceType: "gst", kind: "ends_soon", coveredUntil: "2026-12-20", message: "GST returns is active, but nothing is planned after Dec 2026.", fix: "generate_deadlines" },
    ]);
  });

  it("flags an active service with nothing upcoming at all", () => {
    expect(coverageGaps([{ serviceType: "income_tax", frequency: "annual" }], [{ type: "itr", dueDate: "2026-07-31" }], TODAY)).toEqual([
      { serviceType: "income_tax", kind: "no_upcoming_events", coveredUntil: null, message: "Income tax is active, but no deadlines are planned.", fix: "generate_deadlines" },
    ]);
  });

  it("a fully generated calendar has no gaps", () => {
    const p = profile({ serviceTypes: ["gst", "income_tax", "tds", "payroll", "company_law"], taxAuditApplicable: "yes" });
    const ev = generateEvents(p, RULES, OVERRIDES, { today: TODAY });
    const services = p.serviceTypes.map((s) => ({ serviceType: s, frequency: s === "income_tax" || s === "company_law" ? ("annual" as const) : ("monthly" as const) }));
    expect(coverageGaps(services, ev, TODAY)).toEqual([]);
  });

  it("ignores cancelled events, ops steps, inactive and one-time services, and services with no statutory dates", () => {
    const events = [
      { type: "gstr_3b" as const, dueDate: "2027-09-20", status: "cancelled" as const },
      { type: "gstr_1" as const, dueDate: "2027-09-05", source: "ops_template" as const },
    ];
    expect(coverageGaps([{ serviceType: "gst", frequency: "monthly" }], events, TODAY)[0].kind).toBe("no_upcoming_events");
    expect(coverageGaps([{ serviceType: "gst", frequency: "monthly", isActive: false }], [], TODAY)).toEqual([]);
    expect(coverageGaps([{ serviceType: "incorporation", frequency: "one_time" }, { serviceType: "bookkeeping", frequency: "monthly" }], [], TODAY)).toEqual([]);
  });

  it("recognises GST forms stored as `custom`, and events by their rule", () => {
    expect(coverageGaps([{ serviceType: "gst", frequency: "annual" }], [{ type: "custom", formCode: "GSTR-9", dueDate: "2026-12-31" }], TODAY)).toEqual([]);
    expect(
      coverageGaps([{ serviceType: "payroll", frequency: "annual" }], [{ type: "tds", ruleCode: "FORM16", dueDate: "2027-06-15" }], TODAY, { rules: RULES }),
    ).toEqual([]);
  });
});

// =================================================================================================
describe("ops templates (§7.7)", () => {
  it("ships the §7.7 defaults", () => {
    const t = (title: string) => OPS_TEMPLATE_DEFAULTS.find((x) => x.title === title);
    expect(t("Collect bank statements")).toMatchObject({ serviceType: "bookkeeping", frequency: "monthly", dueDayOfMonth: 5, periodOffset: 1 });
    expect(t("Collect sales data")).toMatchObject({ dueDayOfMonth: 7 });
    expect(t("Collect purchase data")).toMatchObject({ dueDayOfMonth: 7 });
    expect(t("Collect expense receipts")).toMatchObject({ dueDayOfMonth: 10 });
    expect(t("GSTR-1 data collection")).toMatchObject({ serviceType: "gst", dueDayOfMonth: 5, periodOffset: 1 });
    expect(t("GSTR-3B reconciliation prep")).toMatchObject({ serviceType: "gst", dueDayOfMonth: 14, periodOffset: 1 });
    expect(t("Tax planning review")).toMatchObject({ serviceType: "income_tax", frequency: "annual", dueMonth: 3, dueDayOfMonth: 1 });
    expect(t("Audit documentation collection")).toMatchObject({ serviceType: "audit", dueMonth: 9, dueDayOfMonth: 1, periodOffset: 1 });
    expect(t("Financial statement preparation")).toMatchObject({ serviceType: "audit", dueMonth: 9, dueDayOfMonth: 15, periodOffset: 1 });
    const keys = OPS_TEMPLATE_DEFAULTS.map((x) => `${x.serviceType}|${x.complianceType}|${x.title}`);
    expect(new Set(keys).size).toBe(keys.length); // U(service_type, compliance_type, title)
  });

  it("generates prep steps for the previous month, as internal (non-statutory) events", () => {
    const ev = generateOpsEvents({ id: "c1", serviceTypes: ["bookkeeping", "gst"] }, OPS_TEMPLATE_DEFAULTS, { today: TODAY });
    const bank = ev.find((e) => e.title === "Collect bank statements for Oct 2026");
    expect(bank).toMatchObject({
      dueDate: "2026-11-05",
      filingPeriod: "Oct 2026",
      source: "ops_template",
      isStatutory: false,
      ruleCode: null,
      formCode: null,
      dedupeKey: "c1|ops:bookkeeping:collect-bank-statements|Oct 2026",
      reminderDays: 3,
    });
    expect(ev.find((e) => e.title === "GSTR-3B reconciliation prep for Sep 2026")).toBeUndefined(); // 14 Oct 2026 has passed
    expect(ev.find((e) => e.title === "GSTR-3B reconciliation prep for Oct 2026")?.dueDate).toBe("2026-11-14");
    expect(ev.every((e) => e.dueDate >= TODAY && e.dueDate <= addMonths(TODAY, 13))).toBe(true);
    expect(ev.some((e) => e.serviceType === "audit")).toBe(false);
    expect(generateOpsEvents({ id: "c1", serviceTypes: ["bookkeeping", "gst"] }, OPS_TEMPLATE_DEFAULTS, { today: TODAY })).toEqual(ev);
  });

  it("annual steps: tax planning on 1 March for the FY; audit steps in September for the previous FY", () => {
    const ev = generateOpsEvents({ id: "c1", serviceTypes: ["income_tax", "audit"] }, OPS_TEMPLATE_DEFAULTS, { today: TODAY });
    expect(ev.find((e) => e.title === "Tax planning review for FY 2026-27")?.dueDate).toBe("2027-03-01");
    expect(ev.find((e) => e.title === "Audit documentation collection for FY 2026-27")?.dueDate).toBe("2027-09-01");
    expect(ev.find((e) => e.title === "Financial statement preparation for FY 2026-27")?.dueDate).toBe("2027-09-15");
    expect(ev.find((e) => e.title === "Audit documentation collection for FY 2025-26")).toBeUndefined(); // 1 Sep 2026 has passed
  });

  it("quarterly templates fall in the chosen month of each quarter", () => {
    const quarterly: OpsTemplate = { serviceType: "tds", complianceType: "tds", title: "Challan reconciliation", description: null, frequency: "quarterly", dueDayOfMonth: 10, dueMonth: 1, periodOffset: 1, reminderDays: 3, isActive: true };
    const ev = generateOpsEvents({ id: "c1", serviceTypes: ["tds"] }, [quarterly], { today: TODAY, horizonMonths: 6 });
    expect(ev.map((e) => [e.dueDate, e.filingPeriod])).toEqual([
      ["2027-01-10", "Q3 2026-27"],
      ["2027-04-10", "Q4 2026-27"],
    ]);
    expect(generateOpsEvents({ id: "c1", serviceTypes: ["tds"] }, [{ ...quarterly, isActive: false }], { today: TODAY })).toEqual([]);
  });
});
