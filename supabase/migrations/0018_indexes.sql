-- 0018 · Indexes on every filter / sort column in §5 and §7 lists, trigram search indexes (§7.18,
-- §13), and an index on every foreign-key column that doesn't already lead an index.
--
-- Trigram indexes on citext columns are on the ::text cast (gin_trgm_ops is a text operator class):
-- to use them, search with `client_code::text ilike …` (e.g. inside a search RPC).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------------------------
create index profiles_role_idx on public.profiles (role) where is_active;
create index employees_active_idx on public.employees (is_active) where deleted_at is null;
create index employees_deleted_at_idx on public.employees (deleted_at);
create index employees_full_name_trgm on public.employees using gin (full_name extensions.gin_trgm_ops);
create index employee_leave_employee_dates_idx on public.employee_leave (employee_id, start_date, end_date);
create index employee_leave_status_idx on public.employee_leave (status, start_date);
create index employee_sessions_open_idx on public.employee_sessions (employee_id, last_active_at) where is_active;
create index employee_sessions_login_idx on public.employee_sessions (employee_id, login_at desc);
create index attendance_records_date_idx on public.attendance_records (date);
create index employee_activities_employee_idx on public.employee_activities (employee_id, performed_at desc);
create index employee_activities_entity_idx on public.employee_activities (entity_type, entity_id);

-- ---------------------------------------------------------------------------------------------
-- Clients (§5.3 indexes; §7.3.1 filters)
-- ---------------------------------------------------------------------------------------------
create index clients_status_idx on public.clients (status) where deleted_at is null;
create index clients_priority_idx on public.clients (priority) where deleted_at is null;
create index clients_owner_idx on public.clients (owner_employee_id) where deleted_at is null;
create index clients_group_idx on public.clients (group_id) where deleted_at is null;
create index clients_deleted_at_idx on public.clients (deleted_at);
create index clients_entity_type_idx on public.clients (entity_type) where deleted_at is null;
create index clients_gst_registration_idx on public.clients (gst_registration, gst_scheme) where deleted_at is null;
create index clients_onboarded_at_idx on public.clients (onboarded_at desc) where deleted_at is null;
create index clients_display_name_lower_idx on public.clients (lower(display_name));
create index clients_display_name_trgm on public.clients using gin (display_name extensions.gin_trgm_ops);
create index clients_legal_name_trgm on public.clients using gin (legal_name extensions.gin_trgm_ops);
create index clients_client_code_trgm on public.clients using gin ((client_code::text) extensions.gin_trgm_ops);
create index clients_email_idx on public.clients (email);
create index clients_phone_idx on public.clients (phone);
create index client_groups_name_trgm on public.client_groups using gin ((name::text) extensions.gin_trgm_ops);

create index client_services_active_idx on public.client_services (service_type, is_active);
create index client_services_next_due_idx on public.client_services (next_due_date) where is_active;
create index client_services_auto_billing_idx on public.client_services (next_billing_date) where auto_invoice and is_active;
create index client_contacts_name_trgm on public.client_contacts using gin (name extensions.gin_trgm_ops);
create index client_contacts_email_idx on public.client_contacts (email);
create index client_contacts_phone_idx on public.client_contacts (phone);
create index client_team_members_employee_idx on public.client_team_members (employee_id, client_id);
create index client_document_checklist_items_client_idx on public.client_document_checklist_items (client_id, sort_order);
create index credential_access_logs_credential_idx on public.credential_access_logs (credential_id, created_at desc);
create index client_acceptances_outcome_idx on public.client_acceptances (outcome, created_at desc);
create index client_acceptances_pan_idx on public.client_acceptances (pan);
create index client_acceptances_gstin_idx on public.client_acceptances (gstin);
create index client_service_fee_history_service_idx on public.client_service_fee_history (client_service_id, changed_at desc);
create index onboarding_drafts_user_idx on public.onboarding_drafts (user_id, updated_at desc);

-- ---------------------------------------------------------------------------------------------
-- Sales (§7.5)
-- ---------------------------------------------------------------------------------------------
create index leads_status_idx on public.leads (status) where deleted_at is null;
create index leads_assigned_idx on public.leads (assigned_to) where deleted_at is null;
create index leads_source_idx on public.leads (source) where deleted_at is null;
create index leads_next_follow_up_idx on public.leads (next_follow_up_at) where deleted_at is null;
create index leads_last_activity_idx on public.leads (last_activity_at) where deleted_at is null;
create index leads_deleted_at_idx on public.leads (deleted_at);
create index leads_created_at_idx on public.leads (created_at desc);
create index leads_name_trgm on public.leads using gin (name extensions.gin_trgm_ops);
create index leads_company_trgm on public.leads using gin (company extensions.gin_trgm_ops);
create index leads_email_idx on public.leads (email);
create index leads_phone_idx on public.leads (phone);

create index quotations_status_idx on public.quotations (status) where deleted_at is null;
create index quotations_valid_until_idx on public.quotations (valid_until) where deleted_at is null;
create index quotations_issue_date_idx on public.quotations (issue_date desc);
create index quotations_created_by_idx on public.quotations (created_by);
create index quotations_deleted_at_idx on public.quotations (deleted_at);
create index quotations_number_trgm on public.quotations using gin (quotation_number extensions.gin_trgm_ops);
create index quotation_items_quotation_idx on public.quotation_items (quotation_id, sort_order);
create index quotation_email_logs_provider_idx on public.quotation_email_logs (provider_message_id);
create index quotation_follow_ups_pending_idx on public.quotation_follow_ups (scheduled_at) where status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Work (§7.6, §7.10)
-- ---------------------------------------------------------------------------------------------
create index tasks_status_idx on public.tasks (status) where deleted_at is null;
create index tasks_priority_idx on public.tasks (priority) where deleted_at is null;
create index tasks_due_date_idx on public.tasks (due_date) where deleted_at is null;
create index tasks_assignee_status_idx on public.tasks (assigned_employee_id, status) where deleted_at is null;
create index tasks_reviewer_status_idx on public.tasks (reviewer_employee_id, status) where deleted_at is null;
create index tasks_client_status_idx on public.tasks (client_id, status) where deleted_at is null;
create index tasks_acceptance_idx on public.tasks (acceptance_status) where deleted_at is null;
create index tasks_service_idx on public.tasks (service_type) where deleted_at is null;
create index tasks_fy_period_idx on public.tasks (financial_year, period_label) where deleted_at is null;
create index tasks_created_at_idx on public.tasks (created_at desc);
create index tasks_deleted_at_idx on public.tasks (deleted_at);
create index tasks_title_trgm on public.tasks using gin (title extensions.gin_trgm_ops);
create index tasks_number_trgm on public.tasks using gin (task_number extensions.gin_trgm_ops);
create index task_status_history_task_idx on public.task_status_history (task_id, changed_at desc);
create index task_comments_task_idx on public.task_comments (task_id, created_at);
create index task_comments_mentions_idx on public.task_comments using gin (mentions);
create index task_checklist_items_task_idx on public.task_checklist_items (task_id, sort_order);
create index task_dependencies_blocker_idx on public.task_dependencies (blocker_task_id);
create index task_automations_next_run_idx on public.task_automations (next_run_at) where is_active;
create index job_template_items_template_idx on public.job_template_items (template_id, sort_order);
create index time_entries_employee_started_idx on public.time_entries (employee_id, started_at desc);
create index time_entries_client_started_idx on public.time_entries (client_id, started_at desc);
create index time_entries_unbilled_idx on public.time_entries (client_id) where billable and invoice_id is null;

-- ---------------------------------------------------------------------------------------------
-- Compliance and registers (§7.7, §7.15)
-- ---------------------------------------------------------------------------------------------
create index compliance_events_client_due_idx on public.compliance_events (client_id, due_date);
create index compliance_events_due_idx on public.compliance_events (due_date) where status = 'pending';
create index compliance_events_status_idx on public.compliance_events (status, workflow_status);
create index compliance_events_type_period_idx on public.compliance_events (type, form_code, filing_period);
create index compliance_events_fy_idx on public.compliance_events (financial_year);
create index compliance_events_rule_idx on public.compliance_events (rule_code, filing_period);
create index filing_records_client_fy_idx on public.filing_records (client_id, financial_year);
create index filing_records_type_idx on public.filing_records (filing_type, financial_year);
create index filing_records_filed_on_idx on public.filing_records (filed_on desc);
create index udin_records_partner_signed_idx on public.udin_records (signing_partner_id, signed_on);
create index udin_records_signed_on_idx on public.udin_records (signed_on desc);
create index statutory_registrations_expiry_idx on public.statutory_registrations (expiry_date) where status = 'active';
create index statutory_registrations_type_idx on public.statutory_registrations (registration_type);
create index dsc_records_expiry_idx on public.dsc_records (expiry_date) where status = 'active';
create index engagement_letters_client_fy_idx on public.engagement_letters (client_id, financial_year);
create index engagement_letters_status_idx on public.engagement_letters (status, expires_at);
create index peer_reviews_valid_until_idx on public.peer_reviews (valid_until);
create index recurring_compliance_templates_active_idx on public.recurring_compliance_templates (service_type) where is_active;

-- ---------------------------------------------------------------------------------------------
-- Money (§7.9)
-- ---------------------------------------------------------------------------------------------
create index invoices_status_idx on public.invoices (status) where deleted_at is null;
create index invoices_client_issue_idx on public.invoices (client_id, issue_date desc) where deleted_at is null;
create index invoices_due_date_idx on public.invoices (due_date) where deleted_at is null;
create index invoices_issue_date_idx on public.invoices (issue_date desc) where deleted_at is null;
create index invoices_open_idx on public.invoices (due_date) where status in ('sent', 'partially_paid') and deleted_at is null;
create index invoices_created_by_idx on public.invoices (created_by);
create index invoices_deleted_at_idx on public.invoices (deleted_at);
create index invoices_number_trgm on public.invoices using gin (invoice_number extensions.gin_trgm_ops);
create index invoice_items_invoice_idx on public.invoice_items (invoice_id, sort_order);
create index payment_receipts_invoice_idx on public.payment_receipts (invoice_id) where reversed_at is null;
create index payment_receipts_date_idx on public.payment_receipts (payment_date desc);
create index payment_receipts_tds_idx on public.payment_receipts (tds_status, tds_quarter) where tds_amount > 0 and reversed_at is null;
create index payment_receipts_deductor_tan_idx on public.payment_receipts (deductor_tan) where tds_amount > 0;
create index credit_notes_issue_date_idx on public.credit_notes (issue_date desc);
create index invoice_follow_ups_invoice_idx on public.invoice_follow_ups (invoice_id, created_at desc);
create index invoice_follow_ups_promised_idx on public.invoice_follow_ups (promised_payment_date) where promised_payment_date is not null;
create index invoice_reminders_pending_idx on public.invoice_reminders (scheduled_for) where status = 'pending';
create index portal_payment_claims_status_idx on public.portal_payment_claims (status, created_at desc);
create index tds_statement_entries_match_idx on public.tds_statement_entries (deductor_tan, tds_amount);
create index tds_statement_entries_fy_idx on public.tds_statement_entries (financial_year, quarter);

-- ---------------------------------------------------------------------------------------------
-- Documents (§7.14)
-- ---------------------------------------------------------------------------------------------
create index documents_client_category_idx on public.documents (client_id, category, financial_year) where deleted_at is null;
create index documents_deleted_at_idx on public.documents (deleted_at);
create index documents_sha256_idx on public.documents (client_id, sha256) where sha256 is not null;
create index documents_expiry_idx on public.documents (expiry_date) where expiry_date is not null and deleted_at is null;
create index documents_renewal_idx on public.documents (renewal_date) where renewal_date is not null and deleted_at is null;
create index documents_retention_idx on public.documents (retention_until);
create index documents_created_at_idx on public.documents (created_at desc);
create index documents_title_trgm on public.documents using gin (title extensions.gin_trgm_ops);
create index document_tags_tag_idx on public.document_tags (tag);
create index document_tags_tag_trgm on public.document_tags using gin ((tag::text) extensions.gin_trgm_ops);
create index document_activities_document_idx on public.document_activities (document_id, created_at desc);
create index document_requests_client_status_idx on public.document_requests (client_id, status);
create index document_requests_open_idx on public.document_requests (last_reminded_at) where status = 'open';
create index document_request_items_request_idx on public.document_request_items (request_id, sort_order);

-- ---------------------------------------------------------------------------------------------
-- Communication (§7.13)
-- ---------------------------------------------------------------------------------------------
create index messages_client_created_idx on public.messages (client_id, created_at desc);
create index messages_provider_idx on public.messages (provider_message_id) where provider_message_id is not null;
create index messages_related_idx on public.messages (related_entity_type, related_entity_id);
create index messages_unread_inbound_idx on public.messages (client_id) where direction = 'inbound' and read_at is null;
create index message_events_message_idx on public.message_events (message_id, at desc);

-- ---------------------------------------------------------------------------------------------
-- Workpapers (§7.8)
-- ---------------------------------------------------------------------------------------------
create index gst_recon_runs_client_period_idx on public.gst_recon_runs (client_id, period);
create index gst_recon_entries_run_bucket_idx on public.gst_recon_entries (run_id, bucket);
create index gst_recon_entries_supplier_idx on public.gst_recon_entries (supplier_gstin);
create index itr_computations_client_fy_idx on public.itr_computations (client_id, financial_year);
create index financial_statements_client_fy_idx on public.financial_statements (client_id, financial_year);
create index tax_notices_status_idx on public.tax_notices (status);
create index tax_notices_reply_due_idx on public.tax_notices (reply_due_date) where status in ('open', 'reply_drafted');
create index tax_notices_hearing_idx on public.tax_notices (hearing_date) where hearing_date is not null;

-- ---------------------------------------------------------------------------------------------
-- Platform (§7.17–§7.20, §8, §13)
-- ---------------------------------------------------------------------------------------------
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx on public.notifications (user_id) where read_at is null and archived_at is null;
create index notifications_entity_idx on public.notifications (entity_type, entity_id);
create index activity_logs_entity_idx on public.activity_logs (entity_type, entity_id, at desc);
create index client_timeline_events_client_idx on public.client_timeline_events (client_id, created_at desc);
create index client_timeline_events_lead_idx on public.client_timeline_events (lead_id, created_at desc);
create index client_timeline_events_type_idx on public.client_timeline_events (event_type);
create index audit_logs_at_idx on public.audit_logs (at desc);
create index audit_logs_user_idx on public.audit_logs (user_id, at desc);
create index audit_logs_event_idx on public.audit_logs (event, at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);
create index saved_views_page_idx on public.saved_views (page) where is_shared;
create index job_runs_name_started_idx on public.job_runs (name, started_at desc);
create index rate_limits_window_idx on public.rate_limits (window_start);
create index recent_searches_user_idx on public.recent_searches (user_id, searched_at desc);

-- ---------------------------------------------------------------------------------------------
-- Law tables (§5.12): lookups by key and date
-- ---------------------------------------------------------------------------------------------
create index statutory_parameters_key_dates_idx on public.statutory_parameters (key, effective_from desc, effective_to);
create index statutory_parameters_unverified_idx on public.statutory_parameters (key) where not verified;
create index due_date_rules_type_idx on public.due_date_rules (compliance_type) where is_active;
create index section_concordance_topic_idx on public.section_concordance (topic);

-- ---------------------------------------------------------------------------------------------
-- ICAI / DPDP
-- ---------------------------------------------------------------------------------------------
create index audit_engagements_partner_fy_idx on public.audit_engagements (engagement_partner_id, financial_year);
create index audit_engagements_stage_idx on public.audit_engagements (stage);
create index audit_engagements_file_assembly_idx on public.audit_engagements (file_assembly_due) where archived_at is null;
create index client_kyc_next_review_idx on public.client_kyc (next_review_on);
create index consent_records_subject_idx on public.consent_records (subject_type, subject_id);
create index data_requests_status_idx on public.data_requests (status, due_by);
create index data_incidents_detected_idx on public.data_incidents (detected_at desc);

-- ---------------------------------------------------------------------------------------------
-- WhatsApp, desktop, covers (§5.13)
-- ---------------------------------------------------------------------------------------------
create index client_whatsapp_groups_client_status_idx on public.client_whatsapp_groups (client_id, status) where deleted_at is null;
create index client_whatsapp_groups_status_idx on public.client_whatsapp_groups (status) where deleted_at is null;
create index client_whatsapp_group_members_group_idx on public.client_whatsapp_group_members (group_id) where removed_on is null;
create index desktop_devices_last_seen_idx on public.desktop_devices (last_seen_at) where revoked_at is null;
create index desktop_device_numbers_number_idx on public.desktop_device_numbers (number_id) where unlinked_at is null;
create index client_covers_cover_ends_idx on public.client_covers (cover_employee_id, ends_at);
create index client_covers_absent_ends_idx on public.client_covers (absent_employee_id, ends_at);
create index client_covers_client_idx on public.client_covers (client_id);

-- ---------------------------------------------------------------------------------------------
-- Every single-column foreign key gets an index if no index already starts with that column.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select con.conrelid::regclass as tbl, cl.relname, att.attname
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and ns.nspname = 'public'
      and array_length(con.conkey, 1) = 1
      and not exists (
        select 1 from pg_index i
        where i.indrelid = con.conrelid and i.indkey[0] = con.conkey[1] and i.indpred is null
      )
    order by cl.relname, att.attname
  loop
    execute format('create index %I on %s (%I)', left(r.relname || '_' || r.attname || '_fk_idx', 63), r.tbl, r.attname);
  end loop;
end;
$$;

update public.app_meta set value = '0018' where key = 'schema_version';
