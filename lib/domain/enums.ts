/**
 * Every Postgres enum in §5.1, as const arrays (in the order the spec lists them) and string-literal
 * unions. Values are exact: the database types are created from the same lists.
 *
 * Derived states ("overdue" for invoices and compliance events) are NOT here: they are computed, never
 * stored (§0.1 rule 10). See `lib/status.ts` for the display vocabulary that includes them.
 *
 * Pure and client-safe.
 */

export const APP_ROLES = ["partner", "manager", "employee", "client"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const CLIENT_STATUSES = ["active", "inactive", "pending", "on_hold"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type ClientPriority = (typeof CLIENT_PRIORITIES)[number];

export const ENTITY_TYPES = [
  "proprietorship",
  "partnership",
  "llp",
  "pvt_ltd",
  "public_ltd",
  "section_8",
  "trust",
  "aop",
  "huf",
  "individual",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const GST_REGISTRATIONS = ["registered", "unregistered", "unknown"] as const;
export type GstRegistration = (typeof GST_REGISTRATIONS)[number];

export const GST_SCHEMES = ["monthly", "qrmp"] as const;
export type GstScheme = (typeof GST_SCHEMES)[number];

export const SERVICE_TYPES = [
  "gst",
  "income_tax",
  "tds",
  "payroll",
  "bookkeeping",
  "audit",
  "company_law",
  "incorporation",
  "other",
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_FREQUENCIES = ["monthly", "quarterly", "annual", "one_time"] as const;
export type ServiceFrequency = (typeof SERVICE_FREQUENCIES)[number];

export const TEAM_ROLES = ["engagement_partner", "review_manager", "preparer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TASK_STATUSES = [
  "not_started",
  "in_progress",
  "data_awaited",
  "under_review",
  "filed_done",
  "on_hold",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_ACCEPTANCES = ["pending", "accepted", "declined"] as const;
export type TaskAcceptance = (typeof TASK_ACCEPTANCES)[number];

export const DECLINE_REASONS = [
  "no_capacity",
  "not_my_client",
  "wrong_skill",
  "needs_info",
  "on_leave",
  "other",
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const AUTOMATION_TYPES = ["recurring_task", "reminder", "escalation"] as const;
export type AutomationType = (typeof AUTOMATION_TYPES)[number];

export const AUTOMATION_FREQUENCIES = ["daily", "weekly", "monthly", "quarterly", "yearly", "custom"] as const;
export type AutomationFrequency = (typeof AUTOMATION_FREQUENCIES)[number];

export const COMPLIANCE_TYPES = [
  "gstr_1",
  "gstr_3b",
  "tds",
  "roc",
  "itr",
  "pf_esic",
  "audit",
  "advance_tax",
  "pt",
  "custom",
] as const;
export type ComplianceType = (typeof COMPLIANCE_TYPES)[number];

/** "overdue" is derived (§5.1), never stored. */
export const COMPLIANCE_STATUSES = ["pending", "completed", "cancelled"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const COMPLIANCE_WORKFLOWS = [
  "not_started",
  "documents_awaited",
  "in_progress",
  "under_review",
  "filed",
  "completed",
] as const;
export type ComplianceWorkflow = (typeof COMPLIANCE_WORKFLOWS)[number];

export const COMPLIANCE_SOURCES = ["statutory_engine", "ops_template", "manual"] as const;
export type ComplianceSource = (typeof COMPLIANCE_SOURCES)[number];

export const LEAD_STATUSES = [
  "new_lead",
  "contacted",
  "quotation_requested",
  "follow_up_required",
  "client_will_revert",
  "proposal_sent",
  "negotiation",
  "won",
  "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = [
  "referral",
  "website",
  "walk_in",
  "cold_call",
  "social_media",
  "whatsapp",
  "existing_client",
  "other",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const QUOTATION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "viewed",
  "accepted",
  "rejected",
  "expired",
  "superseded",
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/** "overdue" is derived (§5.1), never stored. */
export const INVOICE_STATUSES = [
  "draft",
  "awaiting_approval",
  "sent",
  "partially_paid",
  "paid",
  "disputed",
  "waived",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ["bank_transfer", "upi", "cheque", "cash", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CREDIT_NOTE_REASONS = [
  "fee_reduction",
  "service_not_rendered",
  "duplicate",
  "error",
  "goodwill",
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

export const DOCUMENT_CATEGORIES = [
  "gst",
  "tds",
  "roc",
  "audit",
  "income_tax",
  "payroll",
  "bank_statements",
  "invoices",
  "agreements",
  "kyc",
  "engagement",
  "acknowledgements",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_ACTIVITIES = [
  "uploaded",
  "downloaded",
  "viewed",
  "renamed",
  "deleted",
  "version_created",
  "tag_added",
  "tag_removed",
] as const;
export type DocumentActivity = (typeof DOCUMENT_ACTIVITIES)[number];

export const REQUEST_STATUSES = ["open", "completed", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_ITEM_STATUSES = ["pending", "uploaded", "accepted", "rejected"] as const;
export type RequestItemStatus = (typeof REQUEST_ITEM_STATUSES)[number];

export const MESSAGE_CHANNELS = [
  "email",
  "whatsapp_handoff",
  "gmail_handoff",
  "portal",
  "internal_note",
  "call_log",
] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_DIRECTIONS = ["outbound", "inbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = ["pending", "queued", "sent", "handed_off", "delivered", "read", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const TEMPLATE_TYPES = [
  "document_reminder",
  "compliance_reminder",
  "payment_reminder",
  "task_assignment",
  "overdue_notification",
  "quotation",
  "welcome",
  "custom",
] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const NOTIFICATION_TYPES = [
  "task_assigned",
  "task_declined",
  "task_sent_back",
  "task_approved",
  "review_requested",
  "task_overdue",
  "compliance_due",
  "invoice_overdue",
  "invoice_awaiting_approval",
  "payment_received",
  "document_uploaded",
  "quotation_viewed",
  "quotation_responded",
  "leave_requested",
  "leave_decided",
  "expiry_alert",
  "info",
  "warning",
  "cover_started",
  "cover_ending",
  "cover_ended",
  "whatsapp_group_missing",
  "whatsapp_device_linked",
  "whatsapp_client_mode_down",
  "security_alert",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const ATTENDANCE_STATUSES = ["present", "absent", "late_login", "half_day", "on_leave"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const LEAVE_TYPES = ["annual", "sick", "casual", "unpaid", "sabbatical", "other"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_STATUSES = ["requested", "approved", "declined", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const ENGAGEMENT_STATUSES = ["draft", "issued", "signed", "declined", "expired"] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const NOTICE_STATUSES = [
  "open",
  "reply_drafted",
  "replied",
  "hearing",
  "closed_favourable",
  "closed_unfavourable",
  "closed_partial",
] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const REGISTRATION_STATUSES = ["active", "expired", "surrendered", "cancelled"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const DSC_STATUSES = ["active", "expired", "revoked"] as const;
export type DscStatus = (typeof DSC_STATUSES)[number];

export const ACCEPTANCE_OUTCOMES = ["pending", "accepted", "declined"] as const;
export type AcceptanceOutcome = (typeof ACCEPTANCE_OUTCOMES)[number];

export const PEER_REVIEW_STATUSES = ["scheduled", "in_progress", "completed"] as const;
export type PeerReviewStatus = (typeof PEER_REVIEW_STATUSES)[number];

export const AUDIT_EVENTS = [
  "login_success",
  "login_failure",
  "logout",
  "password_change",
  "access_denied",
  "permission_change",
  "data_create",
  "data_update",
  "data_delete",
  "file_upload",
  "file_download",
  "credential_viewed",
  "config_change",
  "user_create",
  "user_update",
  "user_disable",
  "export_run",
  "record_viewed",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export const WHATSAPP_NUMBER_KINDS = ["partner", "managers_office", "staff_office", "other"] as const;
export type WhatsappNumberKind = (typeof WHATSAPP_NUMBER_KINDS)[number];

export const WHATSAPP_GROUP_STATUSES = ["to_create", "active", "closed"] as const;
export type WhatsappGroupStatus = (typeof WHATSAPP_GROUP_STATUSES)[number];

export const WHATSAPP_MEMBER_KINDS = ["firm_number", "client_contact", "other_person"] as const;
export type WhatsappMemberKind = (typeof WHATSAPP_MEMBER_KINDS)[number];

export const COVER_KINDS = ["client", "person"] as const;
export type CoverKind = (typeof COVER_KINDS)[number];

export const COVER_REASONS = ["leave", "absent_today", "workload", "other"] as const;
export type CoverReason = (typeof COVER_REASONS)[number];

/**
 * Every §5.1 enum by its Postgres type name. Used by tests (and anything that needs to iterate the
 * vocabulary, e.g. a schema check) to compare against the database.
 */
export const DB_ENUMS = {
  app_role: APP_ROLES,
  client_status: CLIENT_STATUSES,
  client_priority: CLIENT_PRIORITIES,
  entity_type: ENTITY_TYPES,
  gst_registration: GST_REGISTRATIONS,
  gst_scheme: GST_SCHEMES,
  service_type: SERVICE_TYPES,
  service_frequency: SERVICE_FREQUENCIES,
  team_role: TEAM_ROLES,
  task_status: TASK_STATUSES,
  task_priority: TASK_PRIORITIES,
  task_acceptance: TASK_ACCEPTANCES,
  decline_reason: DECLINE_REASONS,
  automation_type: AUTOMATION_TYPES,
  automation_frequency: AUTOMATION_FREQUENCIES,
  compliance_type: COMPLIANCE_TYPES,
  compliance_status: COMPLIANCE_STATUSES,
  compliance_workflow: COMPLIANCE_WORKFLOWS,
  compliance_source: COMPLIANCE_SOURCES,
  lead_status: LEAD_STATUSES,
  lead_source: LEAD_SOURCES,
  quotation_status: QUOTATION_STATUSES,
  invoice_status: INVOICE_STATUSES,
  payment_method: PAYMENT_METHODS,
  credit_note_reason: CREDIT_NOTE_REASONS,
  document_category: DOCUMENT_CATEGORIES,
  document_activity: DOCUMENT_ACTIVITIES,
  request_status: REQUEST_STATUSES,
  request_item_status: REQUEST_ITEM_STATUSES,
  message_channel: MESSAGE_CHANNELS,
  message_direction: MESSAGE_DIRECTIONS,
  message_status: MESSAGE_STATUSES,
  template_type: TEMPLATE_TYPES,
  notification_type: NOTIFICATION_TYPES,
  attendance_status: ATTENDANCE_STATUSES,
  leave_type: LEAVE_TYPES,
  leave_status: LEAVE_STATUSES,
  engagement_status: ENGAGEMENT_STATUSES,
  notice_status: NOTICE_STATUSES,
  registration_status: REGISTRATION_STATUSES,
  dsc_status: DSC_STATUSES,
  acceptance_outcome: ACCEPTANCE_OUTCOMES,
  peer_review_status: PEER_REVIEW_STATUSES,
  audit_event: AUDIT_EVENTS,
  whatsapp_number_kind: WHATSAPP_NUMBER_KINDS,
  whatsapp_group_status: WHATSAPP_GROUP_STATUSES,
  whatsapp_member_kind: WHATSAPP_MEMBER_KINDS,
  cover_kind: COVER_KINDS,
  cover_reason: COVER_REASONS,
} as const;

export type DbEnumName = keyof typeof DB_ENUMS;
export type DbEnumValue<N extends DbEnumName> = (typeof DB_ENUMS)[N][number];

/** True when `value` is one of the values of the §5.1 enum `name`. */
export function isEnumValue<N extends DbEnumName>(name: N, value: unknown): value is DbEnumValue<N> {
  return typeof value === "string" && (DB_ENUMS[name] as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------------
// Display labels for the non-status enums people pick from in forms. Wording follows the spec where it
// names the options (§7.3.2 wizard, §7.5.1 lead form, §7.6.3 decline reasons, §7.9.4 receipt, §7.11.3
// leave). Status enums have their labels, tones and meanings in `lib/status.ts` (§3.6).
// ---------------------------------------------------------------------------------------------------

/** Entity type labels as the client wizard lists them (§7.3.2). */
export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  proprietorship: "Sole proprietorship",
  partnership: "Partnership firm",
  llp: "LLP",
  pvt_ltd: "Private limited company",
  public_ltd: "Public company",
  section_8: "Section 8 company",
  trust: "Trust",
  aop: "AOP",
  huf: "HUF",
  individual: "Individual",
  other: "Others",
};

/** GST registration labels (§7.3.2). */
export const GST_REGISTRATION_LABELS: Record<GstRegistration, string> = {
  registered: "Registered",
  unregistered: "Not registered",
  unknown: "Not sure yet",
};

export const GST_SCHEME_LABELS: Record<GstScheme, string> = {
  monthly: "Monthly",
  qrmp: "QRMP",
};

/** Service labels as the wizard's service cards name them (§7.3.2 step 2). */
export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  gst: "GST returns",
  income_tax: "Income tax",
  tds: "TDS/TCS",
  payroll: "Payroll (PF/ESIC/PT)",
  bookkeeping: "Bookkeeping",
  audit: "Audit",
  company_law: "ROC/Company law",
  incorporation: "Incorporation",
  other: "Other",
};

/** Filing / billing frequency labels (§7.3.2 step 3, §7.5.2). */
export const SERVICE_FREQUENCY_LABELS: Record<ServiceFrequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  one_time: "One-time",
};

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  engagement_partner: "Engagement partner",
  review_manager: "Review manager",
  preparer: "Preparer",
};

/** Decline reason labels exactly as §7.6.3 words them. */
export const DECLINE_REASON_LABELS: Record<DeclineReason, string> = {
  no_capacity: "No capacity this week",
  not_my_client: "Not my client",
  wrong_skill: "Outside what I do",
  needs_info: "Not enough information to start",
  on_leave: "I'm away when this is due",
  other: "Something else",
};

/** Return-type labels used on the filings grid and calendar (§7.7). */
export const COMPLIANCE_TYPE_LABELS: Record<ComplianceType, string> = {
  gstr_1: "GSTR-1",
  gstr_3b: "GSTR-3B",
  tds: "TDS return",
  roc: "ROC",
  itr: "ITR",
  pf_esic: "PF/ESIC",
  audit: "Audit",
  advance_tax: "Advance tax",
  pt: "Professional tax",
  custom: "Other",
};

/** Lead source labels (§7.5.1). */
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  referral: "Referral",
  website: "Website",
  walk_in: "Walk-in",
  cold_call: "Cold call",
  social_media: "Social media",
  whatsapp: "WhatsApp",
  existing_client: "Existing client",
  other: "Other",
};

/** Payment method labels (§7.9.4). */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer (NEFT/IMPS/RTGS)",
  upi: "UPI",
  cheque: "Cheque",
  cash: "Cash",
  card: "Card",
  other: "Other",
};

export const CREDIT_NOTE_REASON_LABELS: Record<CreditNoteReason, string> = {
  fee_reduction: "Fee reduction",
  service_not_rendered: "Service not rendered",
  duplicate: "Duplicate invoice",
  error: "Error on the invoice",
  goodwill: "Goodwill",
};

/** Leave type labels (§7.11.3). */
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: "Annual",
  sick: "Sick",
  casual: "Casual",
  unpaid: "Unpaid",
  sabbatical: "Sabbatical",
  other: "Other",
};

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  gst: "GST",
  tds: "TDS",
  roc: "ROC",
  audit: "Audit",
  income_tax: "Income tax",
  payroll: "Payroll",
  bank_statements: "Bank statements",
  invoices: "Invoices",
  agreements: "Agreements",
  kyc: "KYC",
  engagement: "Engagement",
  acknowledgements: "Acknowledgements",
  other: "Other",
};
