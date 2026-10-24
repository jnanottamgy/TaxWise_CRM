import { formatDate } from "@/lib/format"
import { AGE_BAND_LABELS } from "@/lib/domain/itr-rulesets"
import { RETURN_KIND_LABEL, type StoredItrInputs } from "@/lib/schemas/itr"
import { SectionCard } from "@/components/app/section-card"
import { TaxFigure } from "@/components/workpapers/itr/itr-ui"

type Item = { label: string; value: number | undefined }

function Group({ title, items }: { title: string; items: Item[] }) {
  const shown = items.filter((i) => i.value !== undefined && i.value !== 0)
  return (
    <SectionCard title={title} headingLevel={3}>
      {shown.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing entered.</p>
      ) : (
        <dl className="divide-y divide-border/70">
          {shown.map((i) => (
            <div key={i.label} className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-sm text-text-muted">{i.label}</dt>
              <dd className="text-right">
                <TaxFigure value={i.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </SectionCard>
  )
}

/**
 * The inputs of a final computation, read-only (§7.8.2: a Final computation is locked). Only what
 * was entered is listed. Server-safe.
 */
export function ItrInputsSummary({ inputs }: { inputs: StoredItrInputs }) {
  const e = inputs.engine
  const inc = e.income ?? {}
  const ear = inc.earlierTransfers ?? {}
  const d = e.deductions ?? {}
  const p = e.taxesPaid ?? {}
  const at = p.advanceTax ?? {}
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <SectionCard title="Assessee and dates" headingLevel={3}>
        <dl className="divide-y divide-border/70 text-sm">
          {[
            ["Assessee", e.assesseeType === "huf" ? "Hindu undivided family" : "Individual"],
            ["Age band", e.assesseeType === "huf" ? "Not applicable" : `${AGE_BAND_LABELS[e.ageBand]}${inputs.ageBandSource === "manual" ? " (set by hand)" : ""}`],
            ["Residence", e.resident === false ? "Non-resident" : "Resident"],
            ["Presumptive income", e.presumptive ? "Yes (44AD / 44ADA)" : "No"],
            ["Kind of return", RETURN_KIND_LABEL[inputs.returnKind]],
            ["Filing date", formatDate(inputs.dates.filingDate)],
            ["Due date of the return", `${formatDate(inputs.dates.dueDate)}${inputs.dueDateSource === "manual" ? " (set by hand)" : ""}`],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-text-muted">{k}</dt>
              <dd className="text-right text-text">{v}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
      <Group
        title="Income"
        items={[
          { label: "Salary (gross)", value: inc.salaryGross },
          { label: "Salary exemptions (old regime)", value: inc.salaryOldRegimeExemptions },
          { label: "House property (net)", value: inc.houseProperty },
          { label: "Business or profession", value: inc.businessProfession },
          { label: "Other sources", value: inc.otherSources },
          { label: "Of which dividends", value: inc.dividends },
          { label: "STCG on listed equity (111A)", value: inc.stcg111a },
          { label: "LTCG on listed equity (112A)", value: inc.ltcg112a },
          { label: "Other LTCG (112)", value: inc.ltcg112 },
          { label: "111A, earlier transfers", value: ear.stcg111a },
          { label: "112A, earlier transfers", value: ear.ltcg112a },
          { label: "112, earlier transfers", value: ear.ltcg112 },
        ]}
      />
      <Group
        title="Deductions claimed"
        items={[
          { label: "80C / 80CCC / 80CCD(1)", value: d.sec80CBasket },
          { label: "80CCD(1B)", value: d.sec80CCD1B },
          { label: "80D, self and family", value: d.sec80D?.selfFamily },
          { label: `80D, parents${d.sec80D?.parentsSenior ? " (senior citizens)" : ""}`, value: d.sec80D?.parents },
          { label: "80G, qualifying amount", value: d.sec80G },
          { label: "80TTA / 80TTB", value: d.sec80TTA_TTB },
          { label: "Other Chapter VI-A (old regime)", value: d.otherOldRegime },
          { label: `Employer NPS, 80CCD(2)${d.governmentEmployer ? " (government employer)" : ""}`, value: d.employerNps80CCD2 },
          { label: "Basic salary + DA", value: d.basicPlusDa },
          { label: "Other, both regimes", value: d.otherBothRegimes },
        ]}
      />
      <Group
        title="Taxes paid"
        items={[
          { label: "TDS and TCS", value: p.tdsTcs },
          { label: "Advance tax, by 15 June", value: at.q1 },
          { label: "Advance tax, by 15 September", value: at.q2 },
          { label: "Advance tax, by 15 December", value: at.q3 },
          { label: "Advance tax, by 15 March", value: at.q4 },
          { label: "Advance tax, 16–31 March", value: at.afterQ4 },
          ...(p.selfAssessment ?? []).map((s, i) => ({ label: `Self-assessment ${i + 1}, ${formatDate(s.paidOn)}`, value: s.amount })),
        ]}
      />
    </div>
  )
}
