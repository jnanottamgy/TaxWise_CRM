import type { StatusTone } from "@/lib/status"
import { formatDate } from "@/lib/format"
import { formatINR, toPaise } from "@/lib/domain/money"
import { istDateOf } from "@/lib/domain/fy"
import { udinStatus } from "@/lib/domain/ceiling"
import {
  REPORT_TYPE_LABELS,
  caroApplicability,
  fileAssemblyCountdown,
  materialityComplete,
  type SystemCheck,
} from "@/lib/domain/audit-stages"
import type { AuditDetail } from "@/lib/data/audits"
import { assemblyWords } from "@/components/audits/audit-ui"

/** A dialog the engagement page can open from a step's live fact. */
export type AuditDialogKind = "edit" | "materiality" | "report" | "company_facts" | "record_letter" | "confirm_limit"

/** The live fact beside a checklist step (§6.9): what the app knows, with the way to fix it. */
export type StepFact = { tone: StatusTone; text: string; link?: { href: string; label: string }; action?: { kind: AuditDialogKind; label: string } }

const rupees = (v: number) => formatINR(toPaise(v))

/**
 * The live facts for each system-checked step, from the engagement as loaded (the database gate is
 * the control; these explain it). Pure and server-safe.
 */
export function systemFacts(d: AuditDetail, today: string, opts: { isPartner: boolean }): Partial<Record<SystemCheck, StepFact>> {
  const e = d.engagement
  const clientProfile = `/clients/${d.client.id}?tab=profile`
  const out: Partial<Record<SystemCheck, StepFact>> = {}

  // KYC Norms
  if (!d.kyc.complete) {
    out.kyc = { tone: "danger", text: `KYC incomplete: ${d.kyc.missing.join(", ")}.`, link: { href: clientProfile, label: "Open the KYC" } }
  } else if (d.kyc.review_due) {
    out.kyc = { tone: "warning", text: "KYC is complete, but the annual re-confirmation is due.", link: { href: "/quality?tab=kyc&state=review_due", label: "Re-confirm" } }
  } else {
    out.kyc = { tone: "success", text: "KYC complete for the client's category and re-confirmed within the year." }
  }

  // Conflict and independence check (client_acceptances)
  const a = d.acceptance
  if (!a) out.acceptance = { tone: "danger", text: "No conflict check is recorded for this client.", link: { href: "/acceptance", label: "Open the register" } }
  else if (a.outcome === "accepted") out.acceptance = { tone: "success", text: `Conflict check accepted${a.decided_at ? ` on ${formatDate(istDateOf(a.decided_at))}` : ""}.` }
  else if (a.outcome === "declined") out.acceptance = { tone: "danger", text: "The latest conflict check declined this client.", link: { href: "/acceptance", label: "Open the register" } }
  else out.acceptance = { tone: "warning", text: "The conflict check is waiting for a decision.", link: { href: "/acceptance", label: "Decide it" } }

  // Previous auditor (Clause 8)
  if (e.had_previous_auditor === null) {
    out.previous_auditor = { tone: "warning", text: "Say whether another CA was the auditor before.", action: { kind: "edit", label: "Answer it" } }
  } else if (e.had_previous_auditor === false) {
    out.previous_auditor = { tone: "success", text: "First audit by a CA: no previous auditor to write to." }
  } else {
    const letters = d.communications.filter((c) => c.audit_engagement_id === e.id || (c.audit_engagement_id === null && c.engagement_type === e.audit_type))
    const proven = letters.find((c) => c.delivery_proof_document_id)
    if (proven) {
      const reply = proven.reply_received_on ? `reply received ${formatDate(proven.reply_received_on)}` : "no reply recorded yet"
      out.previous_auditor = { tone: "success", text: `Letter to ${proven.previous_auditor_name} sent ${formatDate(proven.letter_sent_on)}, proof of delivery filed; ${reply}.` }
    } else if (letters.length) {
      out.previous_auditor = { tone: "danger", text: `The letter to ${letters[0].previous_auditor_name} has no proof of delivery yet.`, action: { kind: "record_letter", label: "Add the proof" } }
    } else {
      out.previous_auditor = { tone: "danger", text: "Record the letter to the previous auditor, with proof of delivery.", action: { kind: "record_letter", label: "Record the letter" } }
    }
  }

  // Peer review
  if (!e.requires_peer_reviewed_auditor) out.peer_review = { tone: "success", text: "The entity doesn't need a peer-reviewed auditor." }
  else if (d.peerReview) out.peer_review = { tone: "success", text: `Certificate${d.peerReview.certificate_no ? ` ${d.peerReview.certificate_no}` : ""} valid until ${formatDate(d.peerReview.valid_until)}.` }
  else out.peer_review = { tone: "danger", text: "No peer review certificate is valid today.", link: { href: "/quality?tab=peer-reviews", label: "Peer review" } }

  // Ceilings (§6.8)
  const l = d.limit
  if (d.stage !== "acceptance") out.limits = { tone: "success", text: "Checked when the engagement was accepted." }
  else if (!l || l.kind === null) out.limits = { tone: "success", text: "No audit limit applies to this type of engagement." }
  else if (l.level === "unknown") out.limits = { tone: "warning", text: l.message ?? "Record the company's facts to check the company audit limit.", action: { kind: "company_facts", label: "Company facts" } }
  else if (l.level === "block") out.limits = { tone: "danger", text: l.message ?? "Over the company audit limit." }
  else if (l.level === "confirm" && !l.overridden)
    out.limits = { tone: "danger", text: l.message ?? "Over the tax audit ceiling.", action: opts.isPartner ? { kind: "confirm_limit", label: "Confirm as a Partner" } : undefined }
  else if (l.level === "confirm" || l.level === "warn") out.limits = { tone: "warning", text: l.message ?? "Close to the limit." }
  else out.limits = { tone: "success", text: l.message ?? (l.kind === "tax_audit" ? `Tax audit ${l.position} of ${l.limit} for the engagement partner.` : "Within the company audit limit.") }

  // SA 210
  const letter = d.letters.find(
    (x) => (x.status === "issued" || x.status === "signed") && (x.audit_engagement_id === e.id || (x.audit_engagement_id === null && (x.audit_type === e.audit_type || (x.audit_type === null && x.service_types.includes("audit"))))),
  )
  if (letter) {
    const on = letter.signed_at ?? letter.issued_at
    out.engagement_letter = { tone: "success", text: `Engagement letter ${letter.status === "signed" ? "signed" : "issued"}${on ? ` on ${formatDate(istDateOf(on))}` : ""} for FY ${letter.financial_year}.` }
  } else {
    out.engagement_letter = { tone: "danger", text: `No engagement letter Issued or Signed for FY ${e.financial_year} covers this audit (SA 210).`, link: { href: `/engagement-letters?client=${d.client.id}`, label: "Engagement letters" } }
  }

  // SA 320
  out.materiality = materialityComplete(d.materiality)
    ? { tone: "success", text: `Overall ${rupees(d.materiality!.overall)}, performance ${rupees(d.materiality!.performance)}, clearly trivial ${rupees(d.materiality!.trivial)}.` }
    : { tone: "danger", text: "Materiality isn't recorded yet.", action: { kind: "materiality", label: "Record materiality" } }

  // SA 700/705
  out.opinion =
    e.report_type && e.report_date
      ? { tone: "success", text: `${REPORT_TYPE_LABELS[e.report_type as keyof typeof REPORT_TYPE_LABELS] ?? e.report_type}, report dated ${formatDate(e.report_date)}.` }
      : { tone: "warning", text: "Record the type of opinion and the report date.", action: { kind: "report", label: "Record the report" } }

  // CARO 2020
  if (d.auditType === "statutory_companies_act") {
    const ind = caroApplicability(d.company, d.params)
    if (e.caro_applicable === null) out.caro = { tone: "warning", text: `Not decided. ${ind.reason}`, action: { kind: "report", label: "Record the decision" } }
    else out.caro = { tone: "success", text: e.caro_applicable ? "CARO 2020 applies: the report includes the Order's matters." : "CARO 2020 doesn't apply to this company." }
  }

  // UDIN (60 days from signing)
  if (!e.report_date) out.udin = { tone: "muted", text: "Generated once the report is signed." }
  else if (d.linkedUdin) {
    const st = udinStatus({ signedOn: d.linkedUdin.signed_on, generatedOn: d.linkedUdin.generated_on, today }, d.ceiling)
    out.udin =
      st.state === "generated_late"
        ? { tone: "warning", text: `UDIN ${d.linkedUdin.udin} was generated ${formatDate(d.linkedUdin.generated_on)}, after the 60 days from signing.` }
        : { tone: "success", text: `UDIN ${d.linkedUdin.udin} generated ${formatDate(d.linkedUdin.generated_on)}.` }
  } else {
    const st = udinStatus({ signedOn: e.report_date, generatedOn: null, today }, d.ceiling)
    out.udin =
      st.state === "overdue"
        ? { tone: "danger", text: "No UDIN linked, and the 60 days from signing have passed.", action: { kind: "report", label: "Link the UDIN" } }
        : { tone: "warning", text: `No UDIN linked yet; generate it by ${formatDate(st.dueBy)}.`, action: { kind: "report", label: "Link the UDIN" } }
  }

  // SA 230
  const c = fileAssemblyCountdown({ reportDate: e.report_date, archivedOn: e.archived_at ? istDateOf(e.archived_at) : null, today }, d.params)
  const w = assemblyWords(c)
  out.assembly = c.due ? { tone: w.tone, text: `Due ${formatDate(c.due)}: ${w.label.toLowerCase()}.` } : { tone: "muted", text: w.meaning ?? w.label }

  return out
}
