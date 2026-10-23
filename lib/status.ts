/**
 * The status vocabulary (§3.6): for every status enum, the label people see, its tone (the colour of
 * the StatusChip dot, §3.1) and its meaning: what it means and what happens next, shown when the chip
 * is hovered or tapped (§3.4). Status is never shown by colour alone: always the label, and the
 * meaning for keyboard, touch and screen-reader users.
 *
 * The derived "overdue" states for invoices and compliance events are display values only; they are
 * computed from the status and due date (§0.1 rule 10) and never stored.
 *
 * Client-safe.
 */

import type {
  AttendanceStatus,
  ClientPriority,
  ClientStatus,
  ComplianceStatus,
  ComplianceWorkflow,
  DscStatus,
  EngagementStatus,
  InvoiceStatus,
  LeadStatus,
  LeaveStatus,
  NoticeStatus,
  QuotationStatus,
  RegistrationStatus,
  RequestItemStatus,
  RequestStatus,
  TaskAcceptance,
  TaskPriority,
  TaskStatus,
  WhatsappGroupStatus,
} from "@/lib/domain/enums";

/**
 * Chip tones. The first five are the §3.1 status tokens; `muted` is `--text-muted` (finished, paused or
 * kept for history) and `neutral` is `--text` (ordinary, nothing to flag).
 */
export const STATUS_TONES = ["success", "warning", "danger", "info", "violet", "muted", "neutral"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export type StatusInfo = {
  /** The exact §3.6 wording. */
  label: string;
  tone: StatusTone;
  /** One or two short sentences: "<Label>: what it means. What happens next." */
  meaning: string;
  /** A shorter label for dense grids (the filings grid cells, §7.7), when there is one. */
  shortLabel?: string;
};

/** Invoice statuses as displayed: the stored ones plus the derived "overdue" (§3.6). */
export type InvoiceDisplayStatus = InvoiceStatus | "overdue";
/** Compliance statuses as displayed: the stored ones plus the derived "overdue" (§3.6). */
export type ComplianceDisplayStatus = ComplianceStatus | "overdue";

const CLIENT_STATUS: Record<ClientStatus, StatusInfo> = {
  active: { label: "Active", tone: "success", meaning: "Active: included in billing runs, reminders and work allocation." },
  pending: {
    label: "Pending",
    tone: "warning",
    meaning: "Pending: onboarding isn't finished. Complete the client wizard to make the client Active.",
  },
  on_hold: {
    label: "On hold",
    tone: "violet",
    meaning: "On hold: no new work. Reminders and auto-invoicing are paused until the client is made Active again.",
  },
  inactive: {
    label: "Inactive",
    tone: "muted",
    meaning: "Inactive: kept for history and excluded everywhere: no billing, reminders or new work.",
  },
};

const CLIENT_PRIORITY: Record<ClientPriority, StatusInfo> = {
  low: { label: "Low", tone: "muted", meaning: "Low priority: routine work, scheduled around higher-priority clients." },
  medium: { label: "Medium", tone: "neutral", meaning: "Medium priority: the default. Work is scheduled in due-date order." },
  high: { label: "High", tone: "warning", meaning: "High priority: this client's work goes before Medium and Low clients'." },
  critical: {
    label: "Critical",
    tone: "danger",
    meaning: "Critical priority: this client's work goes first, and any delay is raised with a Partner.",
  },
};

const TASK_STATUS: Record<TaskStatus, StatusInfo> = {
  not_started: {
    label: "Not started",
    tone: "muted",
    meaning: "Not started: assigned, but work hasn't begun. Move it to In progress when you start.",
  },
  in_progress: {
    label: "In progress",
    tone: "info",
    meaning: "In progress: the preparer is working on it. Submit it for review when it's ready.",
  },
  data_awaited: {
    label: "Data awaited",
    tone: "warning",
    meaning: "Data awaited: blocked on the client. Shows on the manager's call list.",
  },
  under_review: {
    label: "Under review",
    tone: "violet",
    meaning: "Under review: the preparer has finished and it waits for a reviewer, who files it or sends it back with a reason.",
  },
  filed_done: {
    label: "Filed",
    tone: "success",
    meaning: "Filed: signed off. Only a Manager or Partner can set this, and never on their own work. Reopening needs a reason.",
  },
  on_hold: {
    label: "On hold",
    tone: "muted",
    meaning: "On hold: paused, with a reason. Move it back to In progress to carry on.",
  },
};

const TASK_ACCEPTANCE: Record<TaskAcceptance, StatusInfo> = {
  pending: {
    label: "Waiting for acceptance",
    tone: "warning",
    meaning: "Waiting for acceptance: the assignee must accept or decline it before its status can change.",
  },
  accepted: { label: "Accepted", tone: "success", meaning: "Accepted: the assignee has taken the task on." },
  declined: {
    label: "Declined",
    tone: "danger",
    meaning: "Declined: the assignee gave a reason and it went back to the manager to reassign.",
  },
};

const TASK_PRIORITY: Record<TaskPriority, StatusInfo> = {
  low: { label: "Low", tone: "muted", meaning: "Low priority: do it when higher-priority work allows." },
  medium: { label: "Medium", tone: "neutral", meaning: "Medium priority: the default. Work it in due-date order." },
  high: { label: "High", tone: "warning", meaning: "High priority: do it before Medium and Low work." },
  urgent: {
    label: "Urgent",
    tone: "danger",
    meaning: "Urgent: do this first, and tell the manager straight away if it can't be done in time.",
  },
};

const LEAD_STATUS: Record<LeadStatus, StatusInfo> = {
  new_lead: {
    label: "New lead",
    tone: "info",
    meaning: "New lead: not contacted yet. Call or message them, then move it to Contacted.",
  },
  contacted: {
    label: "Contacted",
    tone: "info",
    meaning: "Contacted: the first conversation has happened. Record what they need and the next follow-up.",
  },
  quotation_requested: {
    label: "Quotation requested",
    tone: "warning",
    meaning: "Quotation requested: they've asked for a quote. Create a quotation from the lead.",
  },
  follow_up_required: {
    label: "Follow-up required",
    tone: "warning",
    meaning: "Follow-up required: someone must get back to them by the next follow-up date.",
  },
  client_will_revert: {
    label: "Client will revert",
    tone: "muted",
    meaning: "Client will revert: waiting for them to come back. A reminder comes up at the next follow-up time.",
  },
  proposal_sent: {
    label: "Proposal sent",
    tone: "info",
    meaning: "Proposal sent: a quotation is with them. Follow-ups go on day 3, 7 and 14 while it's open.",
  },
  negotiation: {
    label: "Negotiation",
    tone: "violet",
    meaning: "Negotiation: scope or fees are being discussed. Revise the quotation if the terms change.",
  },
  won: { label: "Won", tone: "success", meaning: "Won: they accepted. Convert the lead to a client to start onboarding." },
  lost: { label: "Lost", tone: "danger", meaning: "Lost: closed with a reason, which feeds the win/loss analysis." },
};

const QUOTATION_STATUS: Record<QuotationStatus, StatusInfo> = {
  draft: { label: "Draft", tone: "muted", meaning: "Draft: being prepared and saved automatically. Nothing has gone to the client." },
  pending_approval: {
    label: "Pending approval",
    tone: "warning",
    meaning: "Pending approval: a Partner must approve it before it can be sent.",
  },
  approved: { label: "Approved", tone: "info", meaning: "Approved: a Partner approved it. It's ready to send." },
  sent: {
    label: "Sent",
    tone: "info",
    meaning: "Sent: with the client. Follow-ups go on day 3, 7 and 14 until they respond or it expires.",
  },
  viewed: {
    label: "Viewed",
    tone: "info",
    meaning: "Viewed: the client has opened the link. Follow-ups continue until they respond or it expires.",
  },
  accepted: {
    label: "Accepted",
    tone: "success",
    meaning: "Accepted: the client accepted it. Create the client to start onboarding.",
  },
  rejected: {
    label: "Rejected",
    tone: "danger",
    meaning: "Rejected: the client declined, with a reason. Revise it if there's room to agree.",
  },
  expired: {
    label: "Expired",
    tone: "muted",
    meaning: "Expired: past its valid-until date, so the link no longer takes a response. Revise it to send an updated one.",
  },
  superseded: {
    label: "Superseded",
    tone: "muted",
    meaning: "Superseded: replaced by a revision. Its link no longer takes a response.",
  },
};

const INVOICE_STATUS: Record<InvoiceDisplayStatus, StatusInfo> = {
  draft: {
    label: "Draft",
    tone: "muted",
    meaning: "Draft: not issued yet, so it has no number. Edit it freely; a draft is never overdue.",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    tone: "warning",
    meaning: "Awaiting approval: over the approval limit, so a Partner must approve it before it can be sent.",
  },
  sent: {
    label: "Sent",
    tone: "info",
    meaning: "Sent: issued to the client and waiting for payment. A reminder goes 3 days before the due date.",
  },
  partially_paid: {
    label: "Partially paid",
    tone: "warning",
    meaning: "Partially paid: receipts cover part of it and the rest is outstanding. Set from receipts, never by hand.",
  },
  paid: {
    label: "Paid",
    tone: "success",
    meaning: "Paid: settled in full by receipts, TDS and credit notes. Set from receipts, never by hand.",
  },
  overdue: {
    label: "Overdue",
    tone: "danger",
    meaning: "Overdue: past its due date with a balance outstanding. Reminders go 1, 7 and 15 days after the due date.",
  },
  disputed: {
    label: "Disputed",
    tone: "violet",
    meaning: "Disputed: the client has disputed it, with a reason. Reminders are paused until it's resolved.",
  },
  waived: {
    label: "Waived",
    tone: "muted",
    meaning: "Waived: a Partner wrote off the outstanding amount, with a reason. Reports show it as a write-off.",
  },
};

const COMPLIANCE_STATUS: Record<ComplianceDisplayStatus, StatusInfo> = {
  pending: { label: "Pending", tone: "warning", meaning: "Pending: not filed yet. Reminders go before the due date." },
  completed: { label: "Completed", tone: "success", meaning: "Completed: done and closed." },
  overdue: {
    label: "Overdue",
    tone: "danger",
    meaning: "Overdue: the due date has passed and it isn't filed. File it as soon as possible.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "muted",
    meaning: "Cancelled: no longer needed, for example because the service ended. Kept for history.",
  },
};

const COMPLIANCE_WORKFLOW: Record<ComplianceWorkflow, StatusInfo> = {
  not_started: { label: "Not started", tone: "muted", meaning: "Not started: nobody has begun work on this filing yet." },
  documents_awaited: {
    label: "Documents awaited",
    shortLabel: "Docs awaited",
    tone: "warning",
    meaning: "Documents awaited: waiting for the client's data. Chase it from the manager's call list.",
  },
  in_progress: { label: "In progress", tone: "info", meaning: "In progress: the return is being prepared." },
  under_review: {
    label: "Under review",
    tone: "violet",
    meaning: "Under review: prepared, and waiting for a reviewer to check it before it's filed.",
  },
  filed: {
    label: "Filed",
    tone: "success",
    meaning: "Filed: submitted on the portal. Record the acknowledgement number if it isn't saved yet.",
  },
  completed: { label: "Completed", tone: "success", meaning: "Completed: filed and closed, with nothing left to do." },
};

const NOTICE_STATUS: Record<NoticeStatus, StatusInfo> = {
  open: {
    label: "Open",
    tone: "warning",
    meaning: "Open: received and not answered yet. Reminders go 7 and 2 days before the reply due date.",
  },
  reply_drafted: {
    label: "Reply drafted",
    tone: "violet",
    meaning: "Reply drafted: a reply is ready to be reviewed before it's submitted.",
  },
  replied: {
    label: "Replied",
    tone: "info",
    meaning: "Replied: the reply is submitted. Wait for the authority's response or a hearing date.",
  },
  hearing: {
    label: "Hearing",
    tone: "warning",
    meaning: "Hearing: a hearing is scheduled. Reminders go 7 and 2 days before it.",
  },
  closed_favourable: {
    label: "Closed (favourable)",
    tone: "success",
    meaning: "Closed (favourable): decided in the client's favour. Nothing more to do.",
  },
  closed_unfavourable: {
    label: "Closed (unfavourable)",
    tone: "danger",
    meaning: "Closed (unfavourable): decided against the client. Track the appeal and its limitation date.",
  },
  closed_partial: {
    label: "Closed (partial)",
    tone: "warning",
    meaning: "Closed (partial): decided partly in the client's favour. Decide whether to appeal the rest.",
  },
};

const ATTENDANCE_STATUS: Record<AttendanceStatus, StatusInfo> = {
  present: { label: "Present", tone: "success", meaning: "Present: the first activity of the day was on time." },
  late_login: {
    label: "Late login",
    tone: "warning",
    meaning: "Late login: the first activity came after the start of the day plus the grace period.",
  },
  half_day: {
    label: "Half day",
    tone: "warning",
    meaning: "Half day: active time was below the half-day minimum. A Partner or Manager can correct it, with a reason.",
  },
  absent: {
    label: "Absent",
    tone: "danger",
    meaning: "Absent: no activity on a working day. A Partner or Manager can correct it, with a reason.",
  },
  on_leave: {
    label: "On leave",
    tone: "info",
    meaning: "On leave: approved leave. It takes precedence over every other status for the day.",
  },
};

const ENGAGEMENT_STATUS: Record<EngagementStatus, StatusInfo> = {
  draft: { label: "Draft", tone: "muted", meaning: "Draft: being prepared; it hasn't gone to the client." },
  issued: { label: "Issued", tone: "info", meaning: "Issued: with the client, waiting for their signature." },
  signed: {
    label: "Signed",
    tone: "success",
    meaning: "Signed: the client signed it. Keep the signed copy in the document vault.",
  },
  declined: {
    label: "Declined",
    tone: "danger",
    meaning: "Declined: the client didn't sign. Don't start the work it covers.",
  },
  expired: { label: "Expired", tone: "muted", meaning: "Expired: past its expiry date. Renew it for the next FY." },
};

const REQUEST_ITEM_STATUS: Record<RequestItemStatus, StatusInfo> = {
  pending: {
    label: "Pending",
    tone: "warning",
    meaning: "Pending: waiting for the client to upload it. Reminders repeat until it's uploaded.",
  },
  uploaded: {
    label: "Uploaded",
    tone: "info",
    meaning: "Uploaded: the client has uploaded a file. Accept it, or reject it with a reason.",
  },
  accepted: {
    label: "Accepted",
    tone: "success",
    meaning: "Accepted: checked and accepted. The request completes when every required item is accepted.",
  },
  rejected: {
    label: "Rejected",
    tone: "danger",
    meaning: "Rejected: returned to the client with a reason. They're notified and can upload it again.",
  },
};

const REQUEST_STATUS: Record<RequestStatus, StatusInfo> = {
  open: {
    label: "Open",
    tone: "warning",
    meaning: "Open: waiting for the client. Reminders repeat until nothing is pending; it completes once every required item is accepted.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    meaning: "Completed: every required item has been accepted. Reminders have stopped.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "muted",
    meaning: "Cancelled: no longer needed. The client can't upload against it and no reminders go. Reopen it to use it again.",
  },
};

const REGISTRATION_STATUS: Record<RegistrationStatus, StatusInfo> = {
  active: {
    label: "Active",
    tone: "success",
    meaning: "Active: in force. A reminder comes before the expiry or renewal date.",
  },
  expired: {
    label: "Expired",
    tone: "danger",
    meaning: "Expired: past its expiry date. Renew it, or mark it surrendered or cancelled.",
  },
  surrendered: { label: "Surrendered", tone: "muted", meaning: "Surrendered: given up by the client. Kept for history." },
  cancelled: { label: "Cancelled", tone: "muted", meaning: "Cancelled: cancelled by the authority. Kept for history." },
};

const DSC_STATUS: Record<DscStatus, StatusInfo> = {
  active: {
    label: "Active",
    tone: "success",
    meaning: "Active: valid for signing. Alerts come 30, 15 and 7 days before it expires.",
  },
  expired: {
    label: "Expired",
    tone: "danger",
    meaning: "Expired: it can't be used to sign. Arrange a new DSC before the next filing that needs one.",
  },
  revoked: { label: "Revoked", tone: "muted", meaning: "Revoked: cancelled before its expiry. Kept for history." },
};

const LEAVE_STATUS: Record<LeaveStatus, StatusInfo> = {
  requested: {
    label: "Requested",
    tone: "warning",
    meaning: "Requested: waiting for a decision. Managers decide Employees' leave; Partners decide Managers' and Partners'.",
  },
  approved: {
    label: "Approved",
    tone: "success",
    meaning: "Approved: attendance shows On leave, and assignment checks and capacity allow for it.",
  },
  declined: { label: "Declined", tone: "danger", meaning: "Declined: not approved. The decision note says why." },
  cancelled: {
    label: "Cancelled",
    tone: "muted",
    meaning: "Cancelled: withdrawn, so it has no effect on attendance or capacity.",
  },
};

const WHATSAPP_GROUP_STATUS: Record<WhatsappGroupStatus, StatusInfo> = {
  to_create: {
    label: "To create",
    tone: "warning",
    meaning: "To create: the client's WhatsApp group isn't set up yet. Follow the setup checklist on Client 360.",
  },
  active: { label: "Active", tone: "success", meaning: "Active: the group is set up and in use." },
  closed: { label: "Closed", tone: "muted", meaning: "Closed: no longer used, with a reason recorded. Kept for history." },
};

/** Every §3.6 vocabulary, by the enum it describes. Key order is the order the spec lists them. */
export const STATUS_VOCABULARY = {
  client_status: CLIENT_STATUS,
  client_priority: CLIENT_PRIORITY,
  task_status: TASK_STATUS,
  task_acceptance: TASK_ACCEPTANCE,
  task_priority: TASK_PRIORITY,
  lead_status: LEAD_STATUS,
  quotation_status: QUOTATION_STATUS,
  invoice_status: INVOICE_STATUS,
  compliance_status: COMPLIANCE_STATUS,
  compliance_workflow: COMPLIANCE_WORKFLOW,
  notice_status: NOTICE_STATUS,
  attendance_status: ATTENDANCE_STATUS,
  engagement_status: ENGAGEMENT_STATUS,
  request_status: REQUEST_STATUS,
  request_item_status: REQUEST_ITEM_STATUS,
  registration_status: REGISTRATION_STATUS,
  dsc_status: DSC_STATUS,
  leave_status: LEAVE_STATUS,
  whatsapp_group_status: WHATSAPP_GROUP_STATUS,
} as const;

export type StatusKind = keyof typeof STATUS_VOCABULARY;
export type StatusValue<K extends StatusKind> = keyof (typeof STATUS_VOCABULARY)[K] & string;

/** Values that exist only on screen, computed from status and due date (§0.1 rule 10). */
const DERIVED: Partial<Record<StatusKind, readonly string[]>> = {
  invoice_status: ["overdue"],
  compliance_status: ["overdue"],
};

function humanise(value: string): string {
  const words = value.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

/**
 * The label, tone and meaning for a status value (§3.6). An unknown value (e.g. a status added to the
 * database before the app knows it) still renders: its words, a neutral tone, no explanation.
 */
export function getStatus<K extends StatusKind>(kind: K, value: StatusValue<K> | (string & {}) | null | undefined): StatusInfo {
  const map = STATUS_VOCABULARY[kind] as Readonly<Record<string, StatusInfo>>;
  if (value && Object.prototype.hasOwnProperty.call(map, value)) return map[value];
  const label = value ? humanise(value) : "Unknown";
  return { label, tone: "neutral", meaning: `${label}.` };
}

/** True when the value is in the vocabulary for `kind`. */
export function isKnownStatus<K extends StatusKind>(kind: K, value: unknown): value is StatusValue<K> {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS_VOCABULARY[kind], value);
}

/** True for a display-only derived value ("overdue" for invoices and compliance events). */
export function isDerivedStatus(kind: StatusKind, value: string): boolean {
  return DERIVED[kind]?.includes(value) ?? false;
}

export type StatusOption<K extends StatusKind> = { value: StatusValue<K>; label: string; tone: StatusTone; derived: boolean };

/** The values of a vocabulary in spec order, for filter chips and selects. */
export function statusOptions<K extends StatusKind>(kind: K, opts: { includeDerived?: boolean } = {}): StatusOption<K>[] {
  const map = STATUS_VOCABULARY[kind] as Readonly<Record<string, StatusInfo>>;
  return Object.keys(map)
    .map((value) => ({ value: value as StatusValue<K>, label: map[value].label, tone: map[value].tone, derived: isDerivedStatus(kind, value) }))
    .filter((o) => opts.includeDerived !== false || !o.derived);
}

/**
 * The invoice status to display (§3.6, §7.9.3): "overdue" only for a Sent or Partially paid invoice
 * the view marks overdue (`invoices_view.is_overdue`). A draft is never overdue.
 */
export function invoiceDisplayStatus(status: InvoiceStatus, isOverdue: boolean | null | undefined): InvoiceDisplayStatus {
  return isOverdue && (status === "sent" || status === "partially_paid") ? "overdue" : status;
}

/** The compliance status to display (§3.6): "overdue" only for a Pending event the view marks overdue. */
export function complianceDisplayStatus(status: ComplianceStatus, isOverdue: boolean | null | undefined): ComplianceDisplayStatus {
  return isOverdue && status === "pending" ? "overdue" : status;
}
