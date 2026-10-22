-- 0038 · RLS: messaging and workpapers (§4.1, §4.6, §5.9, §5.10, §7.8, §7.13, §7.22).
--
-- Messages: staff who can see the client read and write the client's thread; the portal sees its
-- own client's portal channel only (never WhatsApp hand-offs, internal notes or call logs), sends
-- portal messages and marks the firm's messages read.
-- Workpapers (§4.1): Partners/Managers, and Employees for their own clients; deletion is
-- Partner/Manager.

set search_path = public, extensions;

-- message_templates: staff read ("use only" for Employees, §4.1); Partner/Manager write.
create policy message_templates_select on public.message_templates
  for select to authenticated using ((select public.is_staff()));
create policy message_templates_insert on public.message_templates
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy message_templates_update on public.message_templates
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy message_templates_delete on public.message_templates
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- =============================================================================================
-- messages (§5.9, §7.13, §7.22)
-- =============================================================================================
create policy messages_select_staff on public.messages
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy messages_select_portal on public.messages
  for select to authenticated
  using (channel = 'portal' and client_id in (select public.portal_client_ids()));
create policy messages_insert_staff on public.messages
  for insert to authenticated
  with check (
    sent_by = (select auth.uid())
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  );
create policy messages_insert_portal on public.messages
  for insert to authenticated
  with check (
    client_id in (select public.portal_client_ids())
    and channel = 'portal'
    and direction = 'inbound'
    and sent_by = (select auth.uid())
    and status in ('sent', 'delivered')
    and template_id is null
  );
create policy messages_update_staff on public.messages
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
-- read receipts: the client marks the firm's portal messages read (§7.22)
create policy messages_update_portal on public.messages
  for update to authenticated
  using (channel = 'portal' and direction = 'outbound' and client_id in (select public.portal_client_ids()))
  with check (channel = 'portal' and direction = 'outbound' and client_id in (select public.portal_client_ids()));
create policy messages_delete on public.messages
  for delete to authenticated using ((select public.is_manager_or_partner()));

create or replace function public.messages_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_role public.app_role;
begin
  if not public.is_api_caller() then
    return new;
  end if;
  v_role := public.app_role();
  if v_role = 'client' then
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new), array['read_at'], 'this message');
  elsif v_role = 'employee' then
    perform public.assert_changed_only(to_jsonb(old), to_jsonb(new),
      array['status', 'provider_message_id', 'error', 'sent_at', 'delivered_at', 'read_at', 'failed_at'], 'this message');
  end if;
  return new;
end;
$$;

create trigger messages_guard before update on public.messages
  for each row execute function public.messages_guard();

-- message_events: delivery history; staff only.
create policy message_events_select on public.message_events
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or message_id in (select m.id from public.messages m where m.client_id in (select public.staff_client_ids()))
  );
create policy message_events_insert on public.message_events
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or message_id in (select m.id from public.messages m where m.client_id in (select public.staff_client_ids()))
  );
revoke update, delete on public.message_events from authenticated;

-- message_attachments (§7.22: portal messages allow attachments).
create policy message_attachments_select_staff on public.message_attachments
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or message_id in (select m.id from public.messages m where m.client_id in (select public.staff_client_ids()))
  );
create policy message_attachments_select_portal on public.message_attachments
  for select to authenticated
  using (
    message_id in (
      select m.id from public.messages m
      where m.channel = 'portal' and m.client_id in (select public.portal_client_ids())
    )
  );
create policy message_attachments_insert_staff on public.message_attachments
  for insert to authenticated
  with check (
    (select public.is_staff())
    and ((select public.is_manager_or_partner())
         or message_id in (select m.id from public.messages m where m.client_id in (select public.staff_client_ids())))
    and ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()))
  );
create policy message_attachments_insert_portal on public.message_attachments
  for insert to authenticated
  with check (
    message_id in (
      select m.id from public.messages m
      where m.channel = 'portal' and m.direction = 'inbound' and m.sent_by = (select auth.uid())
        and m.client_id in (select public.portal_client_ids())
    )
    and document_id in (
      select d.id from public.documents d
      where d.uploaded_by = (select auth.uid()) and d.client_id in (select public.portal_client_ids())
    )
  );
create policy message_attachments_delete on public.message_attachments
  for delete to authenticated using ((select public.is_manager_or_partner()));
revoke update on public.message_attachments from authenticated;

-- =============================================================================================
-- Workpapers (§5.10, §7.8): staff who can see the client read and write; delete Partner/Manager.
-- =============================================================================================
create policy gst_recon_runs_select on public.gst_recon_runs
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy gst_recon_runs_insert on public.gst_recon_runs
  for insert to authenticated
  with check (created_by = (select auth.uid()) and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids())));
create policy gst_recon_runs_update on public.gst_recon_runs
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy gst_recon_runs_delete on public.gst_recon_runs
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy gst_recon_entries_select on public.gst_recon_entries
  for select to authenticated
  using ((select public.is_manager_or_partner()) or run_id in (select r.id from public.gst_recon_runs r));
create policy gst_recon_entries_insert on public.gst_recon_entries
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) or run_id in (select r.id from public.gst_recon_runs r));
create policy gst_recon_entries_update on public.gst_recon_entries
  for update to authenticated
  using ((select public.is_manager_or_partner()) or run_id in (select r.id from public.gst_recon_runs r))
  with check ((select public.is_manager_or_partner()) or run_id in (select r.id from public.gst_recon_runs r));
create policy gst_recon_entries_delete on public.gst_recon_entries
  for delete to authenticated
  using ((select public.is_manager_or_partner()) or run_id in (select r.id from public.gst_recon_runs r));

create policy itr_computations_select on public.itr_computations
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy itr_computations_insert on public.itr_computations
  for insert to authenticated
  with check (created_by = (select auth.uid()) and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids())));
create policy itr_computations_update on public.itr_computations
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy itr_computations_delete on public.itr_computations
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy financial_statements_select on public.financial_statements
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy financial_statements_insert on public.financial_statements
  for insert to authenticated
  with check (created_by = (select auth.uid()) and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids())));
create policy financial_statements_update on public.financial_statements
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy financial_statements_delete on public.financial_statements
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy tax_notices_select on public.tax_notices
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy tax_notices_insert on public.tax_notices
  for insert to authenticated
  with check (created_by = (select auth.uid()) and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids())));
create policy tax_notices_update on public.tax_notices
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy tax_notices_delete on public.tax_notices
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy tax_notice_documents_select on public.tax_notice_documents
  for select to authenticated
  using ((select public.is_manager_or_partner()) or notice_id in (select n.id from public.tax_notices n));
create policy tax_notice_documents_insert on public.tax_notice_documents
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (notice_id in (select n.id from public.tax_notices n) and document_id in (select public.staff_document_ids()))
  );
create policy tax_notice_documents_delete on public.tax_notice_documents
  for delete to authenticated
  using ((select public.is_manager_or_partner()) or notice_id in (select n.id from public.tax_notices n));
revoke update on public.tax_notice_documents from authenticated;

create policy register_portal_mappings_select on public.register_portal_mappings
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy register_portal_mappings_insert on public.register_portal_mappings
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy register_portal_mappings_update on public.register_portal_mappings
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy register_portal_mappings_delete on public.register_portal_mappings
  for delete to authenticated using ((select public.is_manager_or_partner()));

revoke execute on function public.messages_guard() from public, anon, authenticated;

update public.app_meta set value = '0038' where key = 'schema_version';
