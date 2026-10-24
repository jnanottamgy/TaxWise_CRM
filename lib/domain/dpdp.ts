/**
 * Personal data under the DPDP Act 2023 and the DPDP Rules 2025 (§6.10): data principals' requests
 * and their due dates, the breach-response checklist, what statutory retention keeps back from an
 * erasure, and privacy-notice versions.
 *
 * - **Requests** (`data_requests`): access, correction, erasure, grievance and nomination. Each has
 *   a due date from the day it was received (the Rules' outer limit for grievances is 90 days; the
 *   firm keeps the same limit for the other rights until it sets a shorter one) [verify]. Closed
 *   states are completed, resolved, rejected, withdrawn and closed; everything else is open, as the
 *   inbox and dashboards count it.
 * - **Erasure:** statutory retention (tax, GST, audit and company records, §6.8) overrides erasure.
 *   The requester is told what is kept and why.
 * - **Breach** (`data_incidents`): contain; assess; notify the Data Protection Board and the people
 *   affected; record the root cause. The Board's detailed report is due within 72 hours of becoming
 *   aware [verify].
 * - **Notices** (`privacy_notices`): versions "v1", "v2" …; a published version is never edited, so a
 *   change is a new version that portal users acknowledge again.
 *
 * Every period is a parameter (`DPDP_DEFAULTS`, seeded by `DPDP_SEED_PARAMETERS`). Pure and
 * client-safe; "today" and "now" are passed in.
 */

import type { SeedParameterRow, StatutoryParameterRow } from "@/lib/domain/gst";
import { parameterInForce, readParameterNumber } from "@/lib/domain/gst";
import { addDays, diffDays, istDateOf, type DateString } from "@/lib/domain/fy";

// -------------------------------------------------------------------------------------------------
// Requests
// -------------------------------------------------------------------------------------------------

export const DATA_REQUEST_TYPES = ["access", "correction", "erasure", "grievance", "nomination"] as const;
export type DataRequestType = (typeof DATA_REQUEST_TYPES)[number];

export const DATA_REQUEST_TYPE_LABELS: Record<DataRequestType, string> = {
  access: "Access to their data",
  correction: "Correction or completion",
  erasure: "Erasure",
  grievance: "Grievance",
  nomination: "Nomination",
};

export const DATA_REQUEST_TYPE_HINTS: Record<DataRequestType, string> = {
  access: "A summary of the personal data we hold about them, what we do with it, and who we have shared it with.",
  correction: "Correct, complete or update inaccurate or incomplete data.",
  erasure: "Erase data we no longer need, unless a law requires us to keep it.",
  grievance: "A complaint about how we handled their data or an earlier request.",
  nomination: "Name someone to exercise their rights if they die or can't act.",
};

/** `data_requests.status` (checked in the database, 0197). */
export const DATA_REQUEST_STATUSES = ["open", "in_progress", "completed", "resolved", "rejected", "withdrawn"] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

/** The words that close a request (the inbox view 0172 and every count use the same list). */
export const CLOSED_REQUEST_STATUSES = ["closed", "completed", "resolved", "rejected", "withdrawn"] as const;

export function isClosedRequestStatus(status: string): boolean {
  return (CLOSED_REQUEST_STATUSES as readonly string[]).includes(status);
}

export const DATA_REQUEST_STATUS_INFO: Record<DataRequestStatus, { label: string; tone: "warning" | "info" | "success" | "muted" | "danger"; meaning: string }> = {
  open: { label: "Open", tone: "warning", meaning: "Open: received and not yet started. Acknowledge it and verify who is asking." },
  in_progress: { label: "In progress", tone: "info", meaning: "In progress: being worked on. Reply before the due date." },
  completed: { label: "Completed", tone: "success", meaning: "Completed: done and the requester has been told. Closed." },
  resolved: { label: "Resolved", tone: "success", meaning: "Resolved: the grievance is answered. Closed." },
  rejected: { label: "Rejected", tone: "muted", meaning: "Rejected: refused with the reason given to the requester (for example, statutory retention). Closed." },
  withdrawn: { label: "Withdrawn", tone: "muted", meaning: "Withdrawn: the requester no longer wants it. Closed." },
};

/** Who the request is about (`data_requests.subject_type`). */
export const DATA_SUBJECT_TYPES = ["client_contact", "portal_user", "employee", "lead", "other"] as const;
export type DataSubjectType = (typeof DATA_SUBJECT_TYPES)[number];

export const DATA_SUBJECT_TYPE_LABELS: Record<DataSubjectType, string> = {
  client_contact: "A client's contact person",
  portal_user: "A portal user",
  employee: "A member of staff",
  lead: "A lead or enquirer",
  other: "Someone else",
};

/** How it reached us (`data_requests.channel`). */
export const DATA_REQUEST_CHANNELS = ["email", "portal", "phone", "letter", "in_person", "whatsapp", "other"] as const;
export type DataRequestChannel = (typeof DATA_REQUEST_CHANNELS)[number];

export const DATA_REQUEST_CHANNEL_LABELS: Record<DataRequestChannel, string> = {
  email: "Email",
  portal: "Client portal",
  phone: "Phone",
  letter: "Letter",
  in_person: "In person",
  whatsapp: "WhatsApp",
  other: "Other",
};

export type DpdpParams = {
  /** Days from receipt to answer each type of request. */
  responseDays: Record<DataRequestType, number>;
  /** Hours from becoming aware of a breach to the Board's detailed report (72). */
  breachBoardReportHours: number;
  /** Warn this many days before a request is due (7). */
  requestWarnDays: number;
};

export const DPDP_DEFAULTS: DpdpParams = {
  responseDays: { access: 90, correction: 90, erasure: 90, grievance: 90, nomination: 90 },
  breachBoardReportHours: 72,
  requestWarnDays: 7,
};

export const DPDP_PARAM_KEYS = {
  responseDays: "dpdp.request_response_days",
  breachBoardReportHours: "dpdp.breach_board_report_hours",
  requestWarnDays: "dpdp.request_warn_days",
} as const;

/** Rows seeded by migration 0199 ([verify] items unverified). */
export const DPDP_SEED_PARAMETERS: readonly SeedParameterRow[] = [
  {
    key: DPDP_PARAM_KEYS.responseDays,
    value: { access: 90, correction: 90, erasure: 90, grievance: 90, nomination: 90 },
    effectiveFrom: "2025-11-13",
    effectiveTo: null,
    statute: "Digital Personal Data Protection Rules, 2025",
    sectionRef: "Rule 14(3) (grievance redressal) [verify]",
    sourceRef: "DPDP Rules, 2025, notified November 2025 [verify the commencement dates]",
    notes: "Days from receipt to answer a data principal. The Rules set 90 days as the outer limit for grievances; the firm uses the same limit for access, correction, erasure and nomination until it adopts a shorter service standard. [verify] (§6.10).",
    verified: false,
  },
  {
    key: DPDP_PARAM_KEYS.breachBoardReportHours,
    value: 72,
    effectiveFrom: "2025-11-13",
    effectiveTo: null,
    statute: "Digital Personal Data Protection Rules, 2025",
    sectionRef: "Rule 7(2) (intimation of personal data breach) [verify]",
    sourceRef: "DPDP Rules, 2025 [verify]",
    notes: "The Data Protection Board is told of a breach without delay, with the detailed report within 72 hours of becoming aware of it; affected people are told without delay. [verify] (§6.10).",
    verified: false,
  },
  {
    key: DPDP_PARAM_KEYS.requestWarnDays,
    value: 7,
    effectiveFrom: "2025-11-13",
    effectiveTo: null,
    statute: "Firm practice",
    sectionRef: "DPDP request reminders",
    sourceRef: "TaxWise Practice OS specification §6.10",
    notes: "Remind the Partners this many days before a data principal's request is due.",
    verified: true,
  },
];

/** The DPDP parameters in force on a date, each falling back to its default. */
export function resolveDpdpParams(rows: readonly StatutoryParameterRow[], on: DateString): { params: DpdpParams; missing: string[]; unverified: string[] } {
  const missing: string[] = [];
  const unverified: string[] = [];
  const d = DPDP_DEFAULTS;
  const read = <T>(key: string, parse: (v: unknown) => T | null, fallback: T): T => {
    const row = parameterInForce(rows, key, on);
    const parsed = row ? parse(row.value) : null;
    if (parsed === null) {
      missing.push(key);
      return fallback;
    }
    if (row && row.verified === false) unverified.push(key);
    return parsed;
  };
  const positive = (v: unknown) => {
    const n = readParameterNumber(v);
    return n !== null && Number.isInteger(n) && n > 0 ? n : null;
  };
  return {
    params: {
      responseDays: read(
        DPDP_PARAM_KEYS.responseDays,
        (v) => {
          if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
          const o = v as Record<string, unknown>;
          const out = { ...d.responseDays };
          for (const t of DATA_REQUEST_TYPES) {
            const n = positive(o[t]);
            if (n === null) return null;
            out[t] = n;
          }
          return out;
        },
        { ...d.responseDays },
      ),
      breachBoardReportHours: read(DPDP_PARAM_KEYS.breachBoardReportHours, positive, d.breachBoardReportHours),
      requestWarnDays: read(DPDP_PARAM_KEYS.requestWarnDays, positive, d.requestWarnDays),
    },
    missing,
    unverified,
  };
}

/** The due date of a request: the IST day it was received + the response days for its type. */
export function dataRequestDueBy(type: DataRequestType, receivedOn: DateString, params: Pick<DpdpParams, "responseDays"> = DPDP_DEFAULTS): DateString {
  return addDays(receivedOn, params.responseDays[type]);
}

export type RequestUrgency = "closed" | "overdue" | "due_soon" | "open";

/** Where an open request stands against its due date (closed requests are just closed). */
export function dataRequestUrgency(
  input: { status: string; dueBy: DateString | null; today: DateString },
  params: Pick<DpdpParams, "requestWarnDays"> = DPDP_DEFAULTS,
): { urgency: RequestUrgency; daysLeft: number | null } {
  if (isClosedRequestStatus(input.status)) return { urgency: "closed", daysLeft: null };
  if (!input.dueBy) return { urgency: "open", daysLeft: null };
  const left = diffDays(input.dueBy, input.today);
  if (left < 0) return { urgency: "overdue", daysLeft: left };
  return { urgency: left <= params.requestWarnDays ? "due_soon" : "open", daysLeft: left };
}

/**
 * What closing a request needs (mirrors `data_requests_guard`, 0197): a response to the requester
 * for every closed status; for an erasure that is completed or rejected, what is retained and why
 * (statutory retention overrides erasure, §6.10).
 */
export function closeRequirements(input: { type: DataRequestType; toStatus: string; response: string | null; retainedExplanation: string | null }): string[] {
  const missing: string[] = [];
  if (!isClosedRequestStatus(input.toStatus)) return missing;
  if (input.toStatus !== "withdrawn" && !(input.response && input.response.trim())) missing.push("the response given to the requester");
  if (input.type === "erasure" && (input.toStatus === "completed" || input.toStatus === "rejected") && !(input.retainedExplanation && input.retainedExplanation.trim())) {
    missing.push("what is retained and why (or that nothing is retained)");
  }
  return missing;
}

/** Records the law makes the firm keep, which an erasure can't remove (§6.8, §6.10). */
export const STATUTORY_RETENTION_REASONS = [
  { key: "income_tax", label: "Income-tax records", detail: "kept for 6 years from the end of the relevant assessment year (Income-tax Rules, Rule 6F)" },
  { key: "gst", label: "GST records", detail: "kept for 72 months from the due date of the annual return (CGST Act s.36)" },
  { key: "audit", label: "Audit working papers", detail: "kept for at least 7 years from the date of the auditor's report (SQC 1)" },
  { key: "company_books", label: "A company's books held by us", detail: "kept for 8 financial years (Companies Act s.128(5))" },
  { key: "invoices", label: "Our invoices and receipts to them", detail: "kept under GST and income-tax record-keeping rules" },
] as const;
export type RetentionReasonKey = (typeof STATUTORY_RETENTION_REASONS)[number]["key"];

/**
 * The paragraph that tells an erasure requester what is kept and why (§6.10). With no reasons it
 * says nothing is kept.
 */
export function retainedExplanation(keys: readonly RetentionReasonKey[]): string {
  const picked = STATUTORY_RETENTION_REASONS.filter((r) => keys.includes(r.key));
  if (picked.length === 0) return "We have erased the personal data we held about you. Nothing is retained.";
  const items = picked.map((r) => `${r.label}, ${r.detail}`);
  return `We have erased the personal data we no longer need. The law requires us to keep the following, and we will erase it when the period ends: ${items.join("; ")}. We use it only to meet those obligations.`;
}

// -------------------------------------------------------------------------------------------------
// Breach response (data_incidents)
// -------------------------------------------------------------------------------------------------

export const INCIDENT_STEPS = ["contain", "assess", "notify_board", "notify_people", "root_cause"] as const;
export type IncidentStep = (typeof INCIDENT_STEPS)[number];

export const INCIDENT_STEP_LABELS: Record<IncidentStep, string> = {
  contain: "Contain the breach",
  assess: "Assess what was exposed and the risk to people",
  notify_board: "Notify the Data Protection Board",
  notify_people: "Notify the people affected",
  root_cause: "Record the root cause and what changes",
};

export const INCIDENT_STEP_HINTS: Record<IncidentStep, string> = {
  contain: "Stop the leak: revoke access, rotate keys, recall the email, take the device off the network.",
  assess: "Which data categories, how many people, how likely and how serious the harm is.",
  notify_board: "Intimate the Board without delay, and send the detailed report within the time the Rules require.",
  notify_people: "Tell each affected person what happened, what it means for them and what they can do, in plain words.",
  root_cause: "Why it happened, and the changes that stop it happening again.",
};

export const INCIDENT_SEVERITIES = ["low", "medium", "high"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = { low: "Low", medium: "Medium", high: "High" };

export type IncidentFacts = {
  detectedAt: string;
  containedAt: string | null;
  assessedAt: string | null;
  boardNotifiedAt: string | null;
  principalsNotifiedAt: string | null;
  rootCause: string | null;
  closedAt: string | null;
};

/** Which breach-response steps are done. */
export function incidentStepsDone(i: IncidentFacts): Record<IncidentStep, boolean> {
  return {
    contain: Boolean(i.containedAt),
    assess: Boolean(i.assessedAt),
    notify_board: Boolean(i.boardNotifiedAt),
    notify_people: Boolean(i.principalsNotifiedAt),
    root_cause: Boolean(i.rootCause && i.rootCause.trim()),
  };
}

/** The Board's report deadline: detected + 72 hours (ISO timestamp). */
export function boardReportDueAt(detectedAt: string, params: Pick<DpdpParams, "breachBoardReportHours"> = DPDP_DEFAULTS): string {
  return new Date(new Date(detectedAt).getTime() + params.breachBoardReportHours * 3_600_000).toISOString();
}

export type IncidentSummary = {
  done: number;
  total: number;
  open: boolean;
  boardDueAt: string;
  /** Hours left to the Board's report while it isn't notified (negative once late); null when notified. */
  boardHoursLeft: number | null;
  boardLate: boolean;
  /** Steps still to do, in order. */
  remaining: IncidentStep[];
};

/** Progress on the breach checklist and the Board deadline (§6.10). */
export function incidentSummary(i: IncidentFacts, now: Date, params: Pick<DpdpParams, "breachBoardReportHours"> = DPDP_DEFAULTS): IncidentSummary {
  const done = incidentStepsDone(i);
  const remaining = INCIDENT_STEPS.filter((s) => !done[s]);
  const boardDueAt = boardReportDueAt(i.detectedAt, params);
  const hoursLeft = i.boardNotifiedAt ? null : Math.floor((new Date(boardDueAt).getTime() - now.getTime()) / 3_600_000);
  const lateNotified = i.boardNotifiedAt ? new Date(i.boardNotifiedAt).getTime() > new Date(boardDueAt).getTime() : false;
  return {
    done: INCIDENT_STEPS.length - remaining.length,
    total: INCIDENT_STEPS.length,
    open: !i.closedAt,
    boardDueAt,
    boardHoursLeft: hoursLeft,
    boardLate: hoursLeft !== null ? hoursLeft < 0 : lateNotified,
    remaining,
  };
}

/** Closing an incident needs every step done (mirrors `data_incidents_guard`, 0197). */
export function incidentCloseBlockers(i: IncidentFacts): IncidentStep[] {
  const done = incidentStepsDone(i);
  return INCIDENT_STEPS.filter((s) => !done[s]);
}

/** Step timestamps must follow detection and come in a sensible order (contain may precede assess). */
export function incidentDateProblems(i: IncidentFacts): string[] {
  const problems: string[] = [];
  const detected = new Date(i.detectedAt).getTime();
  const check = (at: string | null, label: string) => {
    if (at && new Date(at).getTime() < detected) problems.push(`${label} can't be before the breach was detected.`);
  };
  check(i.containedAt, "Contained");
  check(i.assessedAt, "Assessed");
  check(i.boardNotifiedAt, "The Board's notification");
  check(i.principalsNotifiedAt, "Notifying the people affected");
  return problems;
}

// -------------------------------------------------------------------------------------------------
// Privacy notices and consent
// -------------------------------------------------------------------------------------------------

/** "v1" → 1; anything else → null. */
export function noticeVersionNumber(version: string): number | null {
  const m = /^v(\d{1,4})$/i.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/** The next version label after the existing ones ("v3" after v1, v2). */
export function nextNoticeVersion(existing: readonly string[]): string {
  const max = existing.reduce((m, v) => Math.max(m, noticeVersionNumber(v) ?? 0), 0);
  return `v${max + 1}`;
}

export type NoticeState = "draft" | "current" | "superseded";

/** A notice's state: unpublished → draft; published and current → current; published earlier → superseded. */
export function noticeState(n: { publishedAt: string | null; isCurrent: boolean }): NoticeState {
  if (!n.publishedAt) return "draft";
  return n.isCurrent ? "current" : "superseded";
}

export const NOTICE_STATE_INFO: Record<NoticeState, { label: string; tone: "muted" | "success" | "neutral"; meaning: string }> = {
  draft: { label: "Draft", tone: "muted", meaning: "Draft: not shown to anyone yet. Publish it to make it the notice portal users acknowledge." },
  current: { label: "Current", tone: "success", meaning: "Current: shown to portal users and new leads, who acknowledge it once. Changes need a new version." },
  superseded: { label: "Superseded", tone: "neutral", meaning: "Superseded: replaced by a later version. Kept with the acknowledgements given against it." },
};

/** What a privacy notice must cover (§6.10 "itemised"): each heading, looked for in the markdown. */
export const NOTICE_REQUIRED_TOPICS = [
  { key: "data", label: "What personal data we collect", pattern: /\b(data we (collect|hold)|personal data)\b/i },
  { key: "purpose", label: "Why we use it", pattern: /\b(why|purpose|use it)\b/i },
  { key: "retention", label: "How long we keep it", pattern: /\b(how long|retain|retention|keep it)\b/i },
  { key: "rights", label: "The person's rights", pattern: /\b(rights?|access|correct|erase)\b/i },
  { key: "complain", label: "How to complain to the Data Protection Board", pattern: /\bdata protection board\b/i },
  { key: "contact", label: "The grievance contact", pattern: /\b(grievance|contact|email)\b/i },
] as const;

/** The required topics a notice body doesn't seem to cover (a prompt for the Partner, never a block). */
export function noticeMissingTopics(body: string): string[] {
  return NOTICE_REQUIRED_TOPICS.filter((t) => !t.pattern.test(body)).map((t) => t.label);
}

/** Consent is live when given and not withdrawn. */
export function consentLive(c: { givenAt: string | null; withdrawnAt: string | null }): boolean {
  return Boolean(c.givenAt) && !c.withdrawnAt;
}

/** The IST day an ISO timestamp falls on (received_at → the due-date start). */
export function istDay(value: string): DateString {
  return istDateOf(value);
}

// -------------------------------------------------------------------------------------------------
// Security safeguards: the quarterly restore drill (§6.10 "backups", §12 "A restore drill every
// quarter, recorded in the quality module")
// -------------------------------------------------------------------------------------------------

/** "2026-Q4" for any date in Oct–Dec 2026 (calendar quarters). */
export function calendarQuarterOf(date: DateString): string {
  const [y, m] = date.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** The first and last day of the calendar quarter a date falls in. */
export function calendarQuarterBounds(date: DateString): { start: DateString; end: DateString } {
  const [y, m] = date.split("-").map(Number);
  const firstMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const start = `${y}-${String(firstMonth).padStart(2, "0")}-01`;
  const end = addDays(firstMonth === 10 ? `${y + 1}-01-01` : `${y}-${String(firstMonth + 3).padStart(2, "0")}-01`, -1);
  return { start, end };
}

export type DrillReminder = { quarter: string; kind: "start" | "closing"; quarterEnds: DateString } | null;

/**
 * Whether to remind the Partners about this quarter's restore drill: nothing once a drill is
 * recorded in the quarter; otherwise once in its first `startDays` days and again in its last
 * `closingDays` days.
 */
export function restoreDrillReminder(today: DateString, lastDrillOn: DateString | null, opts: { startDays?: number; closingDays?: number } = {}): DrillReminder {
  const quarter = calendarQuarterOf(today);
  if (lastDrillOn && calendarQuarterOf(lastDrillOn) === quarter) return null;
  const { start, end } = calendarQuarterBounds(today);
  if (diffDays(today, start) < (opts.startDays ?? 15)) return { quarter, kind: "start", quarterEnds: end };
  if (diffDays(end, today) < (opts.closingDays ?? 14)) return { quarter, kind: "closing", quarterEnds: end };
  return null;
}

/** The Board-report reminder for an open incident not yet reported: due within `withinHours`, or late. */
export function boardReportReminder(i: IncidentFacts, now: Date, params: Pick<DpdpParams, "breachBoardReportHours"> = DPDP_DEFAULTS, withinHours = 24): "due_soon" | "late" | null {
  if (i.closedAt || i.boardNotifiedAt) return null;
  const s = incidentSummary(i, now, params);
  if (s.boardHoursLeft === null) return null;
  if (s.boardHoursLeft < 0) return "late";
  return s.boardHoursLeft <= withinHours ? "due_soon" : null;
}

// -------------------------------------------------------------------------------------------------
// The first privacy notice
// -------------------------------------------------------------------------------------------------

/**
 * The first draft a Partner starts from (§6.10 "an itemised privacy notice: what data, why, how
 * long, rights, how to complain, grievance contact"), written from what the firm actually holds in
 * this app. The Partner reviews and edits it before publishing.
 */
export function starterNotice(firm: { name: string; email: string | null; address: string | null }): string {
  const contact = [firm.email ? `email ${firm.email}` : null, firm.address ? `write to us at ${firm.address}` : null].filter(Boolean).join(", or ")
  return [
    `# Privacy notice: ${firm.name}`,
    "",
    `${firm.name} is a firm of Chartered Accountants. This notice explains the personal data we hold as a Data Fiduciary under the Digital Personal Data Protection Act, 2023, why we hold it, for how long, and your rights.`,
    "",
    "## What personal data we collect",
    "- Names, addresses, email addresses and phone numbers of you and the people in your business (directors, partners, contacts).",
    "- PAN, DIN and other identifiers our work needs. We never store a full Aadhaar number.",
    "- Tax and financial records you share with us: returns, computations, financial statements, invoices, bank statements, GST and TDS data.",
    "- Logins to government portals that you authorise us to keep, stored encrypted and used only to file for you.",
    "- Your use of our client portal: sign-ins, documents you upload and messages you send.",
    "",
    "## Why we use it",
    "- To do the work you engage us for: income tax, GST, TDS, audit, accounting and company law services.",
    "- To meet our professional duties as Chartered Accountants, such as KYC, independence and quality control.",
    "- To tell you about deadlines, request documents, bill you and answer your questions.",
    "We share it only with government portals and authorities when filing or responding for you, and with service providers who host our systems under contract. We never sell it.",
    "",
    "## How long we keep it",
    "Tax, GST, audit and company records are kept for the periods the law sets: audit working papers for at least 7 years from the report date, GST records for 72 months from the due date of the annual return, a company's books for 8 financial years, and income-tax records as the Income-tax Rules require. We keep everything else only as long as we need it for the work, and then erase it.",
    "",
    "## Your rights",
    "You can ask to see a summary of the personal data we hold about you, to correct, complete or update it, and to erase what we no longer need. Where the law requires us to keep a record, we will tell you what we keep and why. You can raise a grievance with us, and nominate someone to exercise these rights if you cannot.",
    "",
    "## How to complain",
    "If we do not resolve your grievance, you can complain to the Data Protection Board of India.",
    "",
    "## Grievance contact",
    contact ? `To use any of these rights or to raise a grievance, ${contact}.` : "To use any of these rights or to raise a grievance, contact our office.",
  ].join("\n")
}
