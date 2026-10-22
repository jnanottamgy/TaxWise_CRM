-- 0039 · RLS: platform (notifications, logs, audit, saved views, numbering, jobs, rate limits,
-- searches, app_meta), law tables, ICAI quality records and DPDP records (§4.6, §5.11, §5.12, §6.8,
-- §6.10, §7.15.4, §7.17–§7.21, §7.24, §13).

set search_path = public, extensions;

-- =============================================================================================
-- notifications (§4.6 "each user sees their own only", §9)
--   SELECT / UPDATE / DELETE: own rows (mark read, archive, delete).
--   INSERT: your own; staff may notify anyone (assignments, reviews, approvals); a portal user may
--   send the firm's staff a "document_uploaded" / "info" notice. Links are always in-app ('/…').
--   security_alert notifications come only from SECURITY DEFINER functions (report_role_claim).
-- =============================================================================================
create or replace function public.is_active_staff_profile(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.is_active and p.role in ('partner', 'manager', 'employee')
  )
$$;

comment on function public.is_active_staff_profile(uuid) is 'True for an active Partner/Manager/Employee profile.';
revoke execute on function public.is_active_staff_profile(uuid) from public, anon;
grant execute on function public.is_active_staff_profile(uuid) to authenticated, service_role;

create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy notifications_update_own on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_delete_own on public.notifications
  for delete to authenticated using (user_id = (select auth.uid()));
create policy notifications_insert on public.notifications
  for insert to authenticated
  with check (
    link_url ~ '^/([^/\\]|$)'
    and type <> 'security_alert'
    and read_at is null and archived_at is null
    and (
      user_id = (select auth.uid())
      or ((select public.is_staff()) and public.is_active_staff_profile(user_id))
      or ((select public.is_staff()) and exists (
            select 1 from public.clients c where c.portal_user_id = notifications.user_id))
      or ((select public.is_client()) and type in ('document_uploaded', 'info') and public.is_active_staff_profile(user_id))
    )
  );

-- A notification's content is fixed once sent; its reader only marks it read/archived (and the
-- mailer stamps emailed_at).
create or replace function public.notifications_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.is_api_caller() then
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new), array['read_at', 'archived_at', 'emailed_at'], 'this notification');
  end if;
  return new;
end;
$$;

create trigger notifications_guard before update on public.notifications
  for each row execute function public.notifications_guard();

-- =============================================================================================
-- activity_logs (§5.11): entity history on detail pages. Partners/Managers read all; Employees read
-- the history of entities they can see. Append-only.
-- =============================================================================================
create or replace function public.can_see_entity(p_type text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid;
begin
  if public.is_manager_or_partner() then
    return true;
  end if;
  if not public.is_staff() or p_id is null then
    return false;
  end if;
  case p_type
    when 'client' then return public.can_see_client(p_id);
    when 'task' then return public.can_see_task(p_id);
    when 'document' then select d.client_id into v_client from public.documents d where d.id = p_id;
    when 'compliance_event' then select e.client_id into v_client from public.compliance_events e where e.id = p_id;
    when 'document_request' then select r.client_id into v_client from public.document_requests r where r.id = p_id;
    when 'filing_record' then select f.client_id into v_client from public.filing_records f where f.id = p_id;
    when 'tax_notice' then select n.client_id into v_client from public.tax_notices n where n.id = p_id;
    when 'gst_recon_run' then select g.client_id into v_client from public.gst_recon_runs g where g.id = p_id;
    when 'itr_computation' then select i.client_id into v_client from public.itr_computations i where i.id = p_id;
    when 'financial_statement' then select s.client_id into v_client from public.financial_statements s where s.id = p_id;
    when 'message' then select m.client_id into v_client from public.messages m where m.id = p_id;
    when 'statutory_registration' then select r.client_id into v_client from public.statutory_registrations r where r.id = p_id;
    when 'dsc_record' then select r.client_id into v_client from public.dsc_records r where r.id = p_id;
    else return false;
  end case;
  return v_client is not null and public.can_see_client(v_client);
end;
$$;

comment on function public.can_see_entity(text, uuid) is
  'Whether the caller may see an entity''s history (activity_logs): Partner/Manager all; Employees entities of clients they can see.';
revoke execute on function public.can_see_entity(text, uuid) from public, anon;
grant execute on function public.can_see_entity(text, uuid) to authenticated, service_role;

create policy activity_logs_select on public.activity_logs
  for select to authenticated
  using ((select public.is_manager_or_partner()) or public.can_see_entity(entity_type, entity_id));
create policy activity_logs_insert on public.activity_logs
  for insert to authenticated
  with check (
    (select public.is_staff())
    and (user_id is null or user_id = (select auth.uid()))
    and ((select public.is_manager_or_partner()) or public.can_see_entity(entity_type, entity_id))
  );
revoke update, delete on public.activity_logs from authenticated;

-- =============================================================================================
-- client_timeline_events (§5.11): the client's story. Lead-only rows are Partner/Manager (leads are
-- money-side). The portal can add its own events (uploads, messages) but never reads the timeline.
-- =============================================================================================
create policy client_timeline_events_select on public.client_timeline_events
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy client_timeline_events_insert on public.client_timeline_events
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (
      lead_id is null
      and (performed_by is null or performed_by = (select auth.uid()))
      and (client_id in (select public.staff_client_ids()) or client_id in (select public.portal_client_ids()))
    )
  );
revoke update, delete on public.client_timeline_events from authenticated;

-- =============================================================================================
-- audit_logs (§4.6, §7.20): INSERT only through log_audit_event (SECURITY DEFINER); SELECT Partner
-- only; no UPDATE or DELETE for anyone (the 0017 trigger refuses them even for the service role).
-- =============================================================================================
create policy audit_logs_select_partner on public.audit_logs
  for select to authenticated using ((select public.is_partner()));
revoke insert, update, delete, truncate on public.audit_logs from authenticated, anon;

-- saved_views (§7.6.1): your own views, plus views other staff shared.
create policy saved_views_select on public.saved_views
  for select to authenticated
  using (user_id = (select auth.uid()) or (is_shared and (select public.is_staff())));
create policy saved_views_insert on public.saved_views
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy saved_views_update on public.saved_views
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_views_delete on public.saved_views
  for delete to authenticated using (user_id = (select auth.uid()));

-- number_series (§5.11, §7.21 Settings → Numbering): Partners edit; Partners/Managers read.
-- Numbers themselves are taken through next_document_number().
create policy number_series_select on public.number_series
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy number_series_insert on public.number_series
  for insert to authenticated with check ((select public.is_partner()));
create policy number_series_update on public.number_series
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
revoke delete on public.number_series from authenticated;

-- job_runs (§8, §7.24): Partner reads (diagnostics); jobs write with the service role.
create policy job_runs_select on public.job_runs
  for select to authenticated using ((select public.is_partner()));
revoke insert, update, delete on public.job_runs from authenticated;

-- rate_limits (§13): locked. Only check_rate_limit() (service role) touches it.
revoke all on public.rate_limits from authenticated, anon;

-- recent_searches (§7.18): per user.
create policy recent_searches_own on public.recent_searches
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- app_meta (§0.1 rule 1, §7.24): every signed-in user may read schema_version; migrations write it.
create policy app_meta_select on public.app_meta
  for select to authenticated using (true);
revoke insert, update, delete on public.app_meta from authenticated;

-- =============================================================================================
-- Law tables (§5.12): staff read; Partners write (Settings → Law & rules).
-- =============================================================================================
create policy statutory_parameters_select on public.statutory_parameters
  for select to authenticated using ((select public.is_staff()));
create policy statutory_parameters_insert on public.statutory_parameters
  for insert to authenticated with check ((select public.is_partner()));
create policy statutory_parameters_update on public.statutory_parameters
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy statutory_parameters_delete on public.statutory_parameters
  for delete to authenticated using ((select public.is_partner()));

create policy due_date_rules_select on public.due_date_rules
  for select to authenticated using ((select public.is_staff()));
create policy due_date_rules_insert on public.due_date_rules
  for insert to authenticated with check ((select public.is_partner()));
create policy due_date_rules_update on public.due_date_rules
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy due_date_rules_delete on public.due_date_rules
  for delete to authenticated using ((select public.is_partner()));

create policy due_date_overrides_select on public.due_date_overrides
  for select to authenticated using ((select public.is_staff()));
create policy due_date_overrides_insert on public.due_date_overrides
  for insert to authenticated with check ((select public.is_partner()));
create policy due_date_overrides_update on public.due_date_overrides
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy due_date_overrides_delete on public.due_date_overrides
  for delete to authenticated using ((select public.is_partner()));

create policy section_concordance_select on public.section_concordance
  for select to authenticated using ((select public.is_staff()));
create policy section_concordance_insert on public.section_concordance
  for insert to authenticated with check ((select public.is_partner()));
create policy section_concordance_update on public.section_concordance
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy section_concordance_delete on public.section_concordance
  for delete to authenticated using ((select public.is_partner()));

-- tax_audit_external_counts (§6.8): Partners/Managers read; Partners write.
create policy tax_audit_external_counts_select on public.tax_audit_external_counts
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy tax_audit_external_counts_insert on public.tax_audit_external_counts
  for insert to authenticated with check ((select public.is_partner()));
create policy tax_audit_external_counts_update on public.tax_audit_external_counts
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy tax_audit_external_counts_delete on public.tax_audit_external_counts
  for delete to authenticated using ((select public.is_partner()));

-- =============================================================================================
-- Quality (§7.15.4 "Partner; Managers read-only", §12 restore drills)
-- =============================================================================================
create policy quality_manual_items_select on public.quality_manual_items
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy quality_manual_items_insert on public.quality_manual_items
  for insert to authenticated with check ((select public.is_partner()));
create policy quality_manual_items_update on public.quality_manual_items
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy quality_manual_items_delete on public.quality_manual_items
  for delete to authenticated using ((select public.is_partner()));

create policy restore_drills_select on public.restore_drills
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy restore_drills_insert on public.restore_drills
  for insert to authenticated with check ((select public.is_partner()));
create policy restore_drills_update on public.restore_drills
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy restore_drills_delete on public.restore_drills
  for delete to authenticated using ((select public.is_partner()));

-- independence_declarations (§6.8): each staff member declares for themselves; Partners/Managers read all.
create policy independence_declarations_select on public.independence_declarations
  for select to authenticated
  using ((select public.is_manager_or_partner()) or employee_id = (select public.staff_employee_id()));
create policy independence_declarations_insert on public.independence_declarations
  for insert to authenticated
  with check ((select public.is_partner()) or employee_id = (select public.staff_employee_id()));
create policy independence_declarations_update on public.independence_declarations
  for update to authenticated
  using ((select public.is_partner()) or employee_id = (select public.staff_employee_id()))
  with check ((select public.is_partner()) or employee_id = (select public.staff_employee_id()));
create policy independence_declarations_delete on public.independence_declarations
  for delete to authenticated using ((select public.is_partner()));

-- =============================================================================================
-- DPDP (§6.10)
-- =============================================================================================
-- privacy_notices: staff read all versions; portal users read the published ones (first sign-in).
create policy privacy_notices_select_staff on public.privacy_notices
  for select to authenticated using ((select public.is_staff()));
create policy privacy_notices_select_portal on public.privacy_notices
  for select to authenticated using ((select public.is_client()) and published_at is not null);
create policy privacy_notices_insert on public.privacy_notices
  for insert to authenticated with check ((select public.is_partner()));
create policy privacy_notices_update on public.privacy_notices
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy privacy_notices_delete on public.privacy_notices
  for delete to authenticated using ((select public.is_partner()));

-- consent_records: Partners/Managers manage; a person records and withdraws their own consent.
create policy consent_records_select on public.consent_records
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or (subject_type = 'portal_user' and subject_id = (select auth.uid()))
    or (subject_type = 'employee' and subject_id = (select public.staff_employee_id()))
  );
create policy consent_records_insert on public.consent_records
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or ((select public.is_client()) and subject_type = 'portal_user' and subject_id = (select auth.uid()))
    or (subject_type = 'employee' and subject_id = (select public.staff_employee_id()))
  );
create policy consent_records_update on public.consent_records
  for update to authenticated
  using (
    (select public.is_manager_or_partner())
    or (subject_type = 'portal_user' and subject_id = (select auth.uid()))
    or (subject_type = 'employee' and subject_id = (select public.staff_employee_id()))
  )
  with check (
    (select public.is_manager_or_partner())
    or (subject_type = 'portal_user' and subject_id = (select auth.uid()))
    or (subject_type = 'employee' and subject_id = (select public.staff_employee_id()))
  );
revoke delete on public.consent_records from authenticated;

create or replace function public.consent_records_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if public.is_api_caller() and not public.is_manager_or_partner() then
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new), array['withdrawn_at'], 'this consent record');
  end if;
  return new;
end;
$$;

create trigger consent_records_guard before update on public.consent_records
  for each row execute function public.consent_records_guard();

create policy data_requests_select on public.data_requests
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy data_requests_insert on public.data_requests
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy data_requests_update on public.data_requests
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy data_requests_delete on public.data_requests
  for delete to authenticated using ((select public.is_partner()));

create policy data_incidents_select on public.data_incidents
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy data_incidents_insert on public.data_incidents
  for insert to authenticated with check ((select public.is_partner()));
create policy data_incidents_update on public.data_incidents
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy data_incidents_delete on public.data_incidents
  for delete to authenticated using ((select public.is_partner()));

revoke execute on function public.notifications_guard(), public.consent_records_guard() from public, anon, authenticated;

update public.app_meta set value = '0039' where key = 'schema_version';
