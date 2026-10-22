-- 0043 · Security fixes found by the database test suite (tests/db).
--
-- 1. Views are read-only for the API roles (§4.6).
--    Supabase's default privileges grant anon/authenticated ALL on every new relation in public,
--    views included, and a view over one table is automatically updatable. For the
--    security_invoker = false views (client_services_public, client_credentials_list,
--    client_whatsapp_groups_public, employee_cost_rates) an INSERT/UPDATE/DELETE through the view
--    runs with the view owner's rights, i.e. without the base table's RLS: an Employee could delete
--    stored portal logins, add or deactivate a client's services and rename WhatsApp groups, all of
--    which §4.6 reserves for Partners/Managers. Every view in public is now SELECT-only for
--    authenticated (and nothing for anon); 0049 repeats this for views added later.
--
-- 2. Employees never receive money-side records through the timeline or the message history
--    (§4.1 "An employee never receives fee, invoice, receipt, credit note, quotation or lead data,
--    not in a page, a search result, an API response or an export"; §18.3 Employee item 2).
--    0038/0039 let an Employee read every timeline event and every message of a client they can
--    see, including client_timeline_events of type invoice_sent / payment_received /
--    quotation_sent (§5.11 lists them, with amounts in the title) and emails whose related record
--    is an invoice or a quotation. Partners and Managers are unchanged; the portal's own channel is
--    unchanged (a client reads its own invoice messages).
--    money_side_kind(text): true for an entity or timeline event type on the money side:
--      lead*, quotation*, invoice*, payment*, receipt*, credit_note*, engagement_letter*, fee*,
--      tds_credit*, portal_payment_claim*  (e.g. 'invoice', 'invoice_sent', 'payment_received').
--    is_money_message(related_entity_type, template_id): the message is about a money-side record,
--      or was written from a payment-reminder or quotation template (§7.13.4).
--
-- 3. A document's file lives in its own client's folder (§5.8 storage_path
--    `client-documents/<client_id>/<uuid>.<ext>`, §12, §14 "a client can never read another
--    client's data"). portal_can_read_object(name) granted a portal user any object whose name
--    matched the storage_path of a document they could see, and a portal upload may set its own
--    storage_path: a client could register a document of their own pointing at
--    '<other client id>/file.pdf' and then read the other client's file from storage. Now
--    documents.storage_path (and document_versions.storage_path) must be inside the document's
--    client folder, without '..' segments, and the portal check also requires the object's folder
--    to be the document's client.

set search_path = public, extensions;

-- =============================================================================================
-- 1. Views: SELECT only.
-- =============================================================================================
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on %s from public, anon, authenticated', r.rel);
    execute format('revoke all on %s from anon', r.rel);
  end loop;
end;
$$;

-- =============================================================================================
-- 2. Money-side records.
-- =============================================================================================
create or replace function public.money_side_kind(p_kind text)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(
    lower(btrim(p_kind)) ~ '^(lead|quotation|invoice|payment|receipt|credit_note|engagement_letter|fee|tds_credit|portal_payment_claim)',
    false
  )
$$;

comment on function public.money_side_kind(text) is
  'True for an entity / timeline event type on the money side (lead, quotation, invoice, payment, receipt, credit note, engagement letter, fee, TDS credit) (§4.1).';

create or replace function public.is_money_message(p_related_entity_type text, p_template_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.money_side_kind(p_related_entity_type)
      or exists (
        select 1 from public.message_templates t
        where t.id = p_template_id and t.type in ('payment_reminder', 'quotation')
      )
$$;

comment on function public.is_money_message(text, uuid) is
  'True when a message concerns a money-side record or uses a payment-reminder / quotation template (§4.1, §7.13.4).';

revoke execute on function public.money_side_kind(text), public.is_money_message(text, uuid) from public, anon;
grant execute on function public.money_side_kind(text), public.is_money_message(text, uuid) to authenticated, service_role;

-- =============================================================================================
-- client_timeline_events: Employees see the client's story without lead / quotation / invoice /
-- payment events; nobody but Partners and Managers writes those.
-- =============================================================================================
drop policy if exists client_timeline_events_select on public.client_timeline_events;
create policy client_timeline_events_select on public.client_timeline_events
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or (
      client_id in (select public.staff_client_ids())
      and lead_id is null
      and not public.money_side_kind(event_type)
    )
  );

drop policy if exists client_timeline_events_insert on public.client_timeline_events;
create policy client_timeline_events_insert on public.client_timeline_events
  for insert to authenticated
  with check (
    (select public.is_manager_or_partner())
    or (
      lead_id is null
      and not public.money_side_kind(event_type)
      and (performed_by is null or performed_by = (select auth.uid()))
      and (client_id in (select public.staff_client_ids()) or client_id in (select public.portal_client_ids()))
    )
  );

-- =============================================================================================
-- messages: Employees don't read, write or update messages about money-side records. Child tables
-- (message_events, message_attachments) filter through messages under the caller's RLS, so they
-- follow automatically.
-- =============================================================================================
drop policy if exists messages_select_staff on public.messages;
create policy messages_select_staff on public.messages
  for select to authenticated
  using (
    (select public.is_manager_or_partner())
    or (client_id in (select public.staff_client_ids()) and not public.is_money_message(related_entity_type, template_id))
  );

drop policy if exists messages_insert_staff on public.messages;
create policy messages_insert_staff on public.messages
  for insert to authenticated
  with check (
    sent_by = (select auth.uid())
    and (
      (select public.is_manager_or_partner())
      or (client_id in (select public.staff_client_ids()) and not public.is_money_message(related_entity_type, template_id))
    )
  );

drop policy if exists messages_update_staff on public.messages;
create policy messages_update_staff on public.messages
  for update to authenticated
  using (
    (select public.is_manager_or_partner())
    or (client_id in (select public.staff_client_ids()) and not public.is_money_message(related_entity_type, template_id))
  )
  with check (
    (select public.is_manager_or_partner())
    or (client_id in (select public.staff_client_ids()) and not public.is_money_message(related_entity_type, template_id))
  );

-- =============================================================================================
-- 3. Files stay in their client's folder.
-- =============================================================================================
create or replace function public.storage_path_in_client_folder(p_path text, p_client_id uuid)
returns boolean
language sql
immutable
set search_path = public, extensions
as $$
  select p_path is not null and p_client_id is not null
     and (p_path like p_client_id::text || '/%' or p_path like 'client-documents/' || p_client_id::text || '/%')
     and p_path !~ '(^|/)\.\.?(/|$)'
     and p_path !~ '//'
$$;

comment on function public.storage_path_in_client_folder(text, uuid) is
  'True when a storage path is inside the client''s folder (<client_id>/… or client-documents/<client_id>/…) with no . or .. segments (§5.8, §12).';

revoke execute on function public.storage_path_in_client_folder(text, uuid) from public, anon;
grant execute on function public.storage_path_in_client_folder(text, uuid) to authenticated, service_role;

alter table public.documents
  add constraint documents_storage_path_in_client_folder
  check (public.storage_path_in_client_folder(storage_path, client_id));

create or replace function public.document_versions_path_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client uuid;
begin
  select d.client_id into v_client from public.documents d where d.id = new.document_id;
  if not public.storage_path_in_client_folder(new.storage_path, v_client) then
    raise exception 'USER: A document version''s file must be stored in its client''s folder.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger document_versions_path_guard before insert or update of storage_path, document_id on public.document_versions
  for each row execute function public.document_versions_path_guard();

revoke execute on function public.document_versions_path_guard() from public, anon, authenticated;

create or replace function public.portal_can_read_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select public.is_client() and exists (
    select 1
    from public.documents d
    where d.id in (select public.portal_document_ids())
      and d.client_id = public.storage_first_folder_uuid(p_name)
      and (d.storage_path = p_name or d.storage_path = 'client-documents/' || p_name)
  )
$$;

comment on function public.portal_can_read_object(text) is
  'True when a portal user may read this client-documents object: it is in their client''s folder and is the file of a document the portal shows them (§7.22, §12).';

update public.app_meta set value = '0043' where key = 'schema_version';
