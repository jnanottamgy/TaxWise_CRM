import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { defaultFirmProfile } from "@/server/firm";
import { buildItrPdf } from "@/server/pdf/itr-computation";
import { ITR_RULESET_FY2025_26, ITR_RULESET_FY2026_27 } from "@/lib/domain/itr-rulesets";
import { ItrFormSchema, blankItrForm, computeStored, formToStoredInputs } from "@/lib/schemas/itr";

function computed(fy: "2025-26" | "2026-27") {
  const start = Number(fy.slice(0, 4));
  const values = ItrFormSchema.parse(
    blankItrForm({
      clientId: "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4e",
      financialYear: fy,
      ageBand: "below_60",
      ageBandSource: "auto",
      filingDate: `${start + 1}-09-10`,
      dueDate: `${start + 1}-07-31`,
      returnKind: "non_business",
    }),
  );
  values.income.salaryGross = "2400000";
  values.income.otherSources = "80000";
  values.income.ltcg112a = "300000";
  values.deductions.sec80CBasket = "150000";
  values.taxesPaid.tdsTcs = "300000";
  const stored = formToStoredInputs(values, "individual");
  if (!stored.ok) throw new Error("inputs");
  const c = computeStored(stored.stored, fy === "2025-26" ? ITR_RULESET_FY2025_26 : ITR_RULESET_FY2026_27);
  if (!c.ok) throw new Error("compute");
  return { stored: stored.stored, result: c.result };
}

describe("ITR computation sheet PDF (§11)", () => {
  for (const fy of ["2025-26", "2026-27"] as const) {
    it(`renders FY ${fy} on the letterhead`, async () => {
      const { stored, result } = computed(fy);
      const { bytes, fileName } = await buildItrPdf(defaultFirmProfile(), {
        id: "8c0a9d0e-1d6f-4d8a-9a52-0d1f1c2b3a4f",
        status: fy === "2025-26" ? "final" : "draft",
        label: "Return as filed",
        client: { name: "Anita Rao", legalName: "Anita Rao", code: "TW-C-0042", pan: "ABCPR1234K", address: "Sadashiva Nagar, Bengaluru" },
        inputs: stored,
        result,
        regimeChosen: fy === "2025-26" ? result.recommendedRegime : null,
        preparedBy: "Test Preparer",
        reviewedBy: fy === "2025-26" ? "Test Reviewer" : null,
        reviewedAt: fy === "2025-26" ? "2026-10-20T06:00:00Z" : null,
        finalisedBy: fy === "2025-26" ? "CA Partner" : null,
        finalisedAt: fy === "2025-26" ? "2026-10-21T06:00:00Z" : null,
        ruleSetVerified: fy === "2025-26",
        printedBy: "Test Preparer",
        printedOn: "2026-10-24",
      });
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(5000);
      expect(fileName).toBe(fy === "2025-26" ? "ITR computation TW-C-0042-AY-2026-27.pdf" : "ITR computation TW-C-0042-Tax-year-2026-27.pdf");
    }, 30_000);
  }
});
