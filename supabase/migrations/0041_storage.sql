-- 0041 · Storage buckets and object policies (§2.3, §5.8, §7.14, §12).
--
-- Buckets: client-documents, task-files and generated are private; branding is public-read (the
-- logo only). Files are served through 60-second signed URLs issued after an RLS check (§12).
--
-- client-documents/<client_id>/…  staff who can see the client read and write; a portal user
--                                  uploads under their own client's folder and reads only the
--                                  documents the portal shows them (portal_document_ids()).
-- task-files/<client_id or task_id>/…  staff who can see that client or task.
-- generated/…                      Partners/Managers read (PDF cache, may hold invoices); the server
--                                  writes with the service role.
-- branding/…                       anyone reads; Partners write.

set search_path = public, extensions;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('client-documents', 'client-documents', false, 26214400),
  ('task-files', 'task-files', false, 26214400),
  ('generated', 'generated', false, null),
  ('branding', 'branding', true, 1048576)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- storage_folder_client(name): the first folder segment as a uuid (or null).
create or replace function public.storage_first_folder_uuid(p_name text)
returns uuid
language sql
immutable
set search_path = public, extensions
as $$
  select public.try_uuid((storage.foldername(p_name))[1])
$$;

comment on function public.storage_first_folder_uuid(text) is 'First folder segment of a storage object name, as a uuid (or null).';

-- portal_can_read_object(name): the object is the file of a document the portal user may see.
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
      and (d.storage_path = p_name or d.storage_path = 'client-documents/' || p_name)
  )
$$;

comment on function public.portal_can_read_object(text) is
  'True when a portal user may read this client-documents object: it is the file of a document the portal shows them (§7.22).';

revoke execute on function public.storage_first_folder_uuid(text), public.portal_can_read_object(text) from public, anon;
grant execute on function public.storage_first_folder_uuid(text), public.portal_can_read_object(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- client-documents
-- ---------------------------------------------------------------------------------------------
create policy client_documents_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-documents'
    and (
      (public.is_staff() and public.can_see_client(public.storage_first_folder_uuid(name)))
      or public.portal_can_read_object(name)
    )
  );
create policy client_documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'client-documents'
    and public.can_see_client(public.storage_first_folder_uuid(name))
  );
create policy client_documents_update on storage.objects
  for update to authenticated
  using (bucket_id = 'client-documents' and public.is_staff() and public.can_see_client(public.storage_first_folder_uuid(name)))
  with check (bucket_id = 'client-documents' and public.is_staff() and public.can_see_client(public.storage_first_folder_uuid(name)));
create policy client_documents_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'client-documents'
    and public.can_see_client(public.storage_first_folder_uuid(name))
    and (public.is_manager_or_partner() or owner = auth.uid())
  );

-- ---------------------------------------------------------------------------------------------
-- task-files (first folder: a client id or a task id)
-- ---------------------------------------------------------------------------------------------
create policy task_files_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-files' and public.is_staff()
    and (public.can_see_client(public.storage_first_folder_uuid(name)) or public.can_see_task(public.storage_first_folder_uuid(name)))
  );
create policy task_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-files' and public.is_staff()
    and (public.can_see_client(public.storage_first_folder_uuid(name)) or public.can_see_task(public.storage_first_folder_uuid(name)))
  );
create policy task_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'task-files' and public.is_staff()
    and (public.can_see_client(public.storage_first_folder_uuid(name)) or public.can_see_task(public.storage_first_folder_uuid(name)))
  )
  with check (
    bucket_id = 'task-files' and public.is_staff()
    and (public.can_see_client(public.storage_first_folder_uuid(name)) or public.can_see_task(public.storage_first_folder_uuid(name)))
  );
create policy task_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'task-files' and public.is_staff()
    and (public.can_see_client(public.storage_first_folder_uuid(name)) or public.can_see_task(public.storage_first_folder_uuid(name)))
    and (public.is_manager_or_partner() or owner = auth.uid())
  );

-- ---------------------------------------------------------------------------------------------
-- generated (PDF cache): Partners/Managers read; written by the server (service role).
-- ---------------------------------------------------------------------------------------------
create policy generated_read on storage.objects
  for select to authenticated
  using (bucket_id = 'generated' and public.is_manager_or_partner());

-- ---------------------------------------------------------------------------------------------
-- branding: readable by all (the public logo); Partners write.
-- ---------------------------------------------------------------------------------------------
create policy branding_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'branding');
create policy branding_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'branding' and public.is_partner());
create policy branding_update on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and public.is_partner())
  with check (bucket_id = 'branding' and public.is_partner());
create policy branding_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'branding' and public.is_partner());

update public.app_meta set value = '0041' where key = 'schema_version';
