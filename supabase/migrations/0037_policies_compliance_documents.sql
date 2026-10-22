-- 0037 · RLS: compliance, filings, registers and the documents vault (§4.1, §4.6, §5.6, §5.8, §7.7,
-- §7.14, §7.15, §7.22).
--
-- Staff: rows of clients they can see. Employees: registers read-only (UDIN add if they are the
-- signing member), compliance workflow status and notes, uploads, checklist.
-- Portal (§7.22): the client's own statutory deadlines, filing records the firm marks shareable,
-- document requests and items (upload against an item), documents shared with them or uploaded by
-- them. Never another client's data.

set search_path = public, extensions;

-- =============================================================================================
-- compliance_events (§5.6, §7.7). Firm-level events (client_id null) are Partner/Manager only.
-- =============================================================================================
create policy compliance_events_select_staff on public.compliance_events
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy compliance_events_select_portal on public.compliance_events
  for select to authenticated
  using (is_statutory and client_id in (select public.portal_client_ids()));
create policy compliance_events_insert on public.compliance_events
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy compliance_events_update on public.compliance_events
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy compliance_events_delete on public.compliance_events
  for delete to authenticated using ((select public.is_manager_or_partner()));

create trigger limit_employee_columns before update on public.compliance_events
  for each row execute function public.limit_employee_columns('workflow_status,notes', 'this deadline');

-- recurring_compliance_templates: templates (staff read, Partner/Manager write).
create policy recurring_compliance_templates_select on public.recurring_compliance_templates
  for select to authenticated using ((select public.is_staff()));
create policy recurring_compliance_templates_insert on public.recurring_compliance_templates
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy recurring_compliance_templates_update on public.recurring_compliance_templates
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy recurring_compliance_templates_delete on public.recurring_compliance_templates
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- filing_records (§5.6, §7.6.5, §7.15.2): staff read; Partners/Managers record; the portal sees the
-- ones marked shareable.
create policy filing_records_select_staff on public.filing_records
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy filing_records_select_portal on public.filing_records
  for select to authenticated
  using (shareable_with_client and client_id in (select public.portal_client_ids()));
create policy filing_records_insert on public.filing_records
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy filing_records_update on public.filing_records
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy filing_records_delete on public.filing_records
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- udin_records (§4.1 "UDIN add if signing staff"): firm-level rows (no client) are Partner/Manager.
create policy udin_records_select on public.udin_records
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or client_id in (select public.staff_client_ids())
    or ((select public.is_staff()) and signing_partner_id = (select auth.uid()))
  );
create policy udin_records_insert on public.udin_records
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (
      (select public.is_staff())
      and signing_partner_id = (select auth.uid())
      and (client_id is null or client_id in (select public.staff_client_ids()))
    )
  );
create policy udin_records_update on public.udin_records
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy udin_records_delete on public.udin_records
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- statutory_registrations, dsc_records (§7.15.1): staff read; Partner/Manager write.
create policy statutory_registrations_select on public.statutory_registrations
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy statutory_registrations_insert on public.statutory_registrations
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy statutory_registrations_update on public.statutory_registrations
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy statutory_registrations_delete on public.statutory_registrations
  for delete to authenticated using ((select public.is_manager_or_partner()));

create policy dsc_records_select on public.dsc_records
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy dsc_records_insert on public.dsc_records
  for insert to authenticated with check ((select public.is_manager_or_partner()));
create policy dsc_records_update on public.dsc_records
  for update to authenticated using ((select public.is_manager_or_partner())) with check ((select public.is_manager_or_partner()));
create policy dsc_records_delete on public.dsc_records
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- peer_reviews (§4.1: Managers read-only; Partners edit).
create policy peer_reviews_select on public.peer_reviews
  for select to authenticated using ((select public.is_manager_or_partner()));
create policy peer_reviews_insert on public.peer_reviews
  for insert to authenticated with check ((select public.is_partner()));
create policy peer_reviews_update on public.peer_reviews
  for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy peer_reviews_delete on public.peer_reviews
  for delete to authenticated using ((select public.is_partner()));

-- =============================================================================================
-- Documents (§5.8, §7.14, §7.22)
-- portal_document_ids(): the documents a portal user may see: of their own client, not deleted,
-- and shared with them (shareable_with_client), uploaded by them, attached to a portal message of
-- their client, or the acknowledgement of a filing record marked shareable.
-- =============================================================================================
create or replace function public.portal_document_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d.id
  from public.documents d
  where d.client_id in (select public.portal_client_ids())
    and d.deleted_at is null
    and (
      d.shareable_with_client
      or d.uploaded_by = auth.uid()
      or exists (
        select 1 from public.message_attachments ma
        join public.messages m on m.id = ma.message_id
        where ma.document_id = d.id and m.channel = 'portal' and m.client_id = d.client_id
      )
      or exists (
        select 1 from public.filing_records fr
        where fr.document_id = d.id and fr.shareable_with_client and fr.client_id = d.client_id
      )
    )
$$;

comment on function public.portal_document_ids() is
  'Documents the signed-in portal user may see: their client''s shared documents, their own uploads, portal-message attachments and shareable acknowledgements (§7.22).';

-- portal_linked_document_ids(): documents the portal shows because something else shares them:
-- attachments of the client's portal messages and acknowledgements of shareable filing records.
create or replace function public.portal_linked_document_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select ma.document_id
  from public.message_attachments ma
  join public.messages m on m.id = ma.message_id
  where m.channel = 'portal' and m.client_id in (select public.portal_client_ids())
  union
  select fr.document_id
  from public.filing_records fr
  where fr.shareable_with_client and fr.document_id is not null and fr.client_id in (select public.portal_client_ids())
$$;

comment on function public.portal_linked_document_ids() is
  'Documents shared with the portal user through a portal message attachment or a shareable filing record (§7.22).';

-- staff_document_ids(): documents of clients the staff member can see.
create or replace function public.staff_document_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if public.is_manager_or_partner() then
    return query select d.id from public.documents d;
  elsif public.is_staff() then
    return query select d.id from public.documents d where d.client_id in (select public.staff_client_ids());
  end if;
end;
$$;

comment on function public.staff_document_ids() is 'Documents of clients the calling staff member can see (§4.6).';

create or replace function public.can_see_document(did uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select did is not null and (
    (public.is_staff() and exists (
      select 1 from public.documents d where d.id = did and public.can_see_client(d.client_id) and public.is_staff()
    ))
    or (public.is_client() and did in (select public.portal_document_ids()))
  )
$$;

comment on function public.can_see_document(uuid) is 'Staff: the document''s client is visible. Client: portal_document_ids() (§4.6, §7.22).';

revoke execute on function public.portal_document_ids(), public.portal_linked_document_ids(), public.staff_document_ids(), public.can_see_document(uuid) from public, anon;
grant execute on function public.portal_document_ids(), public.portal_linked_document_ids(), public.staff_document_ids(), public.can_see_document(uuid) to authenticated, service_role;

-- documents
create policy documents_select_staff on public.documents
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
-- Row-based (not id in portal_document_ids()) so a portal upload can read back the row it just
-- inserted: a STABLE function's snapshot can't see that row yet.
create policy documents_select_portal on public.documents
  for select to authenticated
  using (
    client_id in (select public.portal_client_ids())
    and deleted_at is null
    and (
      shareable_with_client
      or uploaded_by = (select auth.uid())
      or id in (select public.portal_linked_document_ids())
    )
  );
create policy documents_insert_staff on public.documents
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and deleted_at is null
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  );
create policy documents_insert_portal on public.documents
  for insert to authenticated
  with check (
    client_id in (select public.portal_client_ids())
    and uploaded_by = (select auth.uid())
    and source = 'client_portal'
    and not shareable_with_client
    and not is_confidential
    and deleted_at is null
  );
create policy documents_update_staff on public.documents
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy documents_delete on public.documents
  for delete to authenticated using ((select public.is_partner()));

-- Employees: describe, re-file and version a document; sharing, confidentiality, retention and
-- deletion are Partner/Manager decisions.
create trigger limit_employee_columns before update on public.documents
  for each row execute function public.limit_employee_columns(
    'title,category,financial_year,period,description,file_name,file_size,mime_type,storage_path,sha256,version,expiry_date,renewal_date',
    'this document');

-- document_versions: append-only, staff who can see the document.
create policy document_versions_select on public.document_versions
  for select to authenticated
  using ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()));
create policy document_versions_insert on public.document_versions
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()))
  );
revoke update, delete on public.document_versions from authenticated;

-- document_tags: staff who can see the document tag it.
create policy document_tags_select on public.document_tags
  for select to authenticated
  using ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()));
create policy document_tags_insert on public.document_tags
  for insert to authenticated
  with check ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()));
create policy document_tags_delete on public.document_tags
  for delete to authenticated
  using ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()));
revoke update on public.document_tags from authenticated;

-- document_activities (§7.14 "every view and download is logged"): anyone who can see the
-- document logs their own activity; staff read the log.
create policy document_activities_select on public.document_activities
  for select to authenticated
  using ((select public.is_manager_or_partner()) or document_id in (select public.staff_document_ids()));
create policy document_activities_insert on public.document_activities
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      (select public.is_manager_or_partner())
      or document_id in (select public.staff_document_ids())
      or document_id in (select public.portal_document_ids())
    )
  );
revoke update, delete on public.document_activities from authenticated;

-- =============================================================================================
-- Document requests (PBC lists, §7.14): staff who can see the client create and manage them; the
-- portal sees its own and uploads against items.
-- =============================================================================================
create policy document_requests_select_staff on public.document_requests
  for select to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy document_requests_select_portal on public.document_requests
  for select to authenticated
  using (client_id in (select public.portal_client_ids()));
create policy document_requests_insert on public.document_requests
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  );
create policy document_requests_update on public.document_requests
  for update to authenticated
  using ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()))
  with check ((select public.is_manager_or_partner()) or client_id in (select public.staff_client_ids()));
create policy document_requests_delete on public.document_requests
  for delete to authenticated using ((select public.is_manager_or_partner()));

create trigger limit_employee_columns before update on public.document_requests
  for each row execute function public.limit_employee_columns(
    'title,status,due_date,notes,last_reminded_at,reminder_every_days', 'this document request');

create policy document_request_items_select_staff on public.document_request_items
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or request_id in (select r.id from public.document_requests r where r.client_id in (select public.staff_client_ids()))
  );
create policy document_request_items_select_portal on public.document_request_items
  for select to authenticated
  using (request_id in (select r.id from public.document_requests r where r.client_id in (select public.portal_client_ids())));
create policy document_request_items_insert on public.document_request_items
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or request_id in (select r.id from public.document_requests r where r.client_id in (select public.staff_client_ids()))
  );
create policy document_request_items_update_staff on public.document_request_items
  for update to authenticated
  using (
    (select public.is_manager_or_partner())
    or request_id in (select r.id from public.document_requests r where r.client_id in (select public.staff_client_ids()))
  )
  with check (
    (select public.is_manager_or_partner())
    or request_id in (select r.id from public.document_requests r where r.client_id in (select public.staff_client_ids()))
  );
create policy document_request_items_update_portal on public.document_request_items
  for update to authenticated
  using (request_id in (select r.id from public.document_requests r where r.client_id in (select public.portal_client_ids())))
  with check (request_id in (select r.id from public.document_requests r where r.client_id in (select public.portal_client_ids())));
create policy document_request_items_delete on public.document_request_items
  for delete to authenticated using ((select public.is_manager_or_partner()));

-- The client uploads against an item: it becomes 'uploaded' and points at their own document of the
-- same client. Accepting and rejecting are the firm's (§7.14).
create or replace function public.document_request_items_portal_guard()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if not public.is_api_caller() or public.app_role() is distinct from 'client' then
    return new;
  end if;
  perform public.assert_changed_only(to_jsonb(old), to_jsonb(new), array['status', 'document_id'], 'this request item');
  if new.status is distinct from old.status and new.status <> 'uploaded' then
    raise exception 'USER: Upload a file for this item; the firm accepts or rejects it.' using errcode = 'P0001';
  end if;
  if old.status = 'accepted' then
    raise exception 'USER: This item has already been accepted.' using errcode = 'P0001';
  end if;
  if new.document_id is not null and not exists (
    select 1 from public.documents d
    join public.document_requests r on r.id = new.request_id
    where d.id = new.document_id and d.client_id = r.client_id and d.uploaded_by = auth.uid() and d.deleted_at is null
  ) then
    raise exception 'USER: Attach a file you uploaded for this request.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger document_request_items_portal_guard before update on public.document_request_items
  for each row execute function public.document_request_items_portal_guard();

revoke execute on function public.document_request_items_portal_guard() from public, anon, authenticated;

update public.app_meta set value = '0037' where key = 'schema_version';
