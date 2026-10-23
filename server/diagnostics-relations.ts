/**
 * The tables and views Settings → Diagnostics checks for (§7.24 "Tables"), kept apart from
 * server/diagnostics.ts so the database tests can compare them with the migrations. Import-free.
 */

/** Every table the app reads or writes (§5, plus the platform tables the build added). */
export const EXPECTED_TABLES = [
  "app_meta", "firm_settings", "profiles", "employees", "employee_leave", "employee_sessions", "attendance_records",
  "employee_activities", "holidays", "client_groups", "clients", "onboarding_drafts", "client_services",
  "client_service_fee_history", "client_contacts", "client_team_members", "client_document_checklist_items",
  "client_credentials", "credential_access_logs", "client_acceptances", "leads", "quotations", "quotation_items",
  "quotation_email_logs", "quotation_follow_ups", "job_templates", "job_template_items", "tasks", "task_status_history",
  "task_comments", "task_attachments", "task_checklist_items", "task_dependencies", "task_automations", "time_entries",
  "compliance_events", "recurring_compliance_templates", "filing_records", "udin_records", "statutory_registrations",
  "dsc_records", "engagement_letters", "peer_reviews", "invoices", "invoice_items", "payment_receipts", "credit_notes",
  "invoice_follow_ups", "invoice_reminders", "portal_payment_claims", "tds_statement_entries", "documents",
  "document_versions", "document_tags", "document_activities", "document_requests", "document_request_items",
  "message_templates", "messages", "message_events", "message_attachments", "gst_recon_runs", "gst_recon_entries",
  "itr_computations", "financial_statements", "tax_notices", "tax_notice_documents", "register_portal_mappings",
  "notifications", "activity_logs", "client_timeline_events", "audit_logs", "saved_views", "number_series", "job_runs",
  "rate_limits", "recent_searches", "statutory_parameters", "due_date_rules", "due_date_overrides",
  "section_concordance", "client_kyc", "previous_auditor_communications", "audit_engagements",
  "tax_audit_external_counts", "privacy_notices", "consent_records", "data_requests", "data_incidents",
  "independence_declarations", "quality_manual_items", "restore_drills", "firm_whatsapp_numbers",
  "client_whatsapp_groups", "client_whatsapp_group_members", "desktop_devices", "desktop_device_numbers", "client_covers",
  // Wave A (0100–0133): email ledger, client status history, upload slots, timesheet weeks.
  "email_deliveries", "email_webhook_events", "client_status_history", "document_uploads", "timesheet_week_approvals",
  "timesheet_week_rows",
] as const;

/** Views with derived state (§0.1 rule 10) and the role-scoped views (§4.6). */
export const EXPECTED_VIEWS = [
  "tasks_view", "invoices_view", "compliance_events_view", "covers_in_force", "client_services_public",
  "client_whatsapp_groups_public", "portal_invoices", "portal_payment_receipts", "whatsapp_links_per_number",
  "tax_audit_ceiling_view", "clients_list", "client_groups_overview", "tasks_list", "unbilled_time_entries",
  "unbilled_time_by_client", "people_overview",
] as const;
