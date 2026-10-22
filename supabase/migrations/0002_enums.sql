-- 0002 · Every enum in §5.1, with exactly the listed values and order.
-- Derived states ("overdue" for tasks, invoices and compliance events) are deliberately NOT enum
-- values: they are computed in views (§0.1 rule 10).

set search_path = public, extensions;

create type public.app_role             as enum ('partner', 'manager', 'employee', 'client');
create type public.client_status        as enum ('active', 'inactive', 'pending', 'on_hold');
create type public.client_priority      as enum ('low', 'medium', 'high', 'critical');
create type public.entity_type          as enum ('proprietorship', 'partnership', 'llp', 'pvt_ltd', 'public_ltd', 'section_8', 'trust', 'aop', 'huf', 'individual', 'other');
create type public.gst_registration     as enum ('registered', 'unregistered', 'unknown');
create type public.gst_scheme           as enum ('monthly', 'qrmp');
create type public.service_type         as enum ('gst', 'income_tax', 'tds', 'payroll', 'bookkeeping', 'audit', 'company_law', 'incorporation', 'other');
create type public.service_frequency    as enum ('monthly', 'quarterly', 'annual', 'one_time');
create type public.team_role            as enum ('engagement_partner', 'review_manager', 'preparer');
create type public.task_status          as enum ('not_started', 'in_progress', 'data_awaited', 'under_review', 'filed_done', 'on_hold');
create type public.task_priority        as enum ('low', 'medium', 'high', 'urgent');
create type public.task_acceptance      as enum ('pending', 'accepted', 'declined');
create type public.decline_reason       as enum ('no_capacity', 'not_my_client', 'wrong_skill', 'needs_info', 'on_leave', 'other');
create type public.automation_type      as enum ('recurring_task', 'reminder', 'escalation');
create type public.automation_frequency as enum ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom');
create type public.compliance_type      as enum ('gstr_1', 'gstr_3b', 'tds', 'roc', 'itr', 'pf_esic', 'audit', 'advance_tax', 'pt', 'custom');
create type public.compliance_status    as enum ('pending', 'completed', 'cancelled');
create type public.compliance_workflow  as enum ('not_started', 'documents_awaited', 'in_progress', 'under_review', 'filed', 'completed');
create type public.compliance_source    as enum ('statutory_engine', 'ops_template', 'manual');
create type public.lead_status          as enum ('new_lead', 'contacted', 'quotation_requested', 'follow_up_required', 'client_will_revert', 'proposal_sent', 'negotiation', 'won', 'lost');
create type public.lead_source          as enum ('referral', 'website', 'walk_in', 'cold_call', 'social_media', 'whatsapp', 'existing_client', 'other');
create type public.quotation_status     as enum ('draft', 'pending_approval', 'approved', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'superseded');
create type public.invoice_status       as enum ('draft', 'awaiting_approval', 'sent', 'partially_paid', 'paid', 'disputed', 'waived');
create type public.payment_method       as enum ('bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other');
create type public.credit_note_reason   as enum ('fee_reduction', 'service_not_rendered', 'duplicate', 'error', 'goodwill');
create type public.document_category    as enum ('gst', 'tds', 'roc', 'audit', 'income_tax', 'payroll', 'bank_statements', 'invoices', 'agreements', 'kyc', 'engagement', 'acknowledgements', 'other');
create type public.document_activity    as enum ('uploaded', 'downloaded', 'viewed', 'renamed', 'deleted', 'version_created', 'tag_added', 'tag_removed');
create type public.request_status       as enum ('open', 'completed', 'cancelled');
create type public.request_item_status  as enum ('pending', 'uploaded', 'accepted', 'rejected');
create type public.message_channel      as enum ('email', 'whatsapp_handoff', 'gmail_handoff', 'portal', 'internal_note', 'call_log');
create type public.message_direction    as enum ('outbound', 'inbound');
create type public.message_status       as enum ('pending', 'queued', 'sent', 'handed_off', 'delivered', 'read', 'failed');
create type public.template_type        as enum ('document_reminder', 'compliance_reminder', 'payment_reminder', 'task_assignment', 'overdue_notification', 'quotation', 'welcome', 'custom');
create type public.notification_type    as enum (
  'task_assigned', 'task_declined', 'task_sent_back', 'task_approved', 'review_requested', 'task_overdue',
  'compliance_due', 'invoice_overdue', 'invoice_awaiting_approval', 'payment_received', 'document_uploaded',
  'quotation_viewed', 'quotation_responded', 'leave_requested', 'leave_decided', 'expiry_alert', 'info', 'warning',
  'cover_started', 'cover_ending', 'cover_ended', 'whatsapp_group_missing', 'whatsapp_device_linked',
  'whatsapp_client_mode_down', 'security_alert'
);
create type public.attendance_status    as enum ('present', 'absent', 'late_login', 'half_day', 'on_leave');
create type public.leave_type           as enum ('annual', 'sick', 'casual', 'unpaid', 'sabbatical', 'other');
create type public.leave_status         as enum ('requested', 'approved', 'declined', 'cancelled');
create type public.engagement_status    as enum ('draft', 'issued', 'signed', 'declined', 'expired');
create type public.notice_status        as enum ('open', 'reply_drafted', 'replied', 'hearing', 'closed_favourable', 'closed_unfavourable', 'closed_partial');
create type public.registration_status  as enum ('active', 'expired', 'surrendered', 'cancelled');
create type public.dsc_status           as enum ('active', 'expired', 'revoked');
create type public.acceptance_outcome   as enum ('pending', 'accepted', 'declined');
create type public.peer_review_status   as enum ('scheduled', 'in_progress', 'completed');
create type public.audit_event          as enum (
  'login_success', 'login_failure', 'logout', 'password_change', 'access_denied', 'permission_change',
  'data_create', 'data_update', 'data_delete', 'file_upload', 'file_download', 'credential_viewed',
  'config_change', 'user_create', 'user_update', 'user_disable', 'export_run', 'record_viewed'
);
create type public.whatsapp_number_kind  as enum ('partner', 'managers_office', 'staff_office', 'other');
create type public.whatsapp_group_status as enum ('to_create', 'active', 'closed');
create type public.whatsapp_member_kind  as enum ('firm_number', 'client_contact', 'other_person');
create type public.cover_kind            as enum ('client', 'person');
create type public.cover_reason          as enum ('leave', 'absent_today', 'workload', 'other');

update public.app_meta set value = '0002' where key = 'schema_version';
